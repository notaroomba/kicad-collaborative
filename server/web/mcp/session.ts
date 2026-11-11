// mcp/session — one live document held by the headless host, the way the browser editor holds
// the one it shows: joined over the collaboration socket, built from the server's snapshot and
// kept current by the ops everybody sends.  Edits made here leave as ordinary ops, so they reach
// the people in the document as they happen and are journalled like anyone else's.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ToolError } from "../ai/design";

const W = globalThis as any;
const K = (): any => W.KiCadCanvas;

export interface DocEntry { docId: string; path: string; docType: string }
export interface Conn { base: string; token: string; agent: string }

/** What a commit needs to be taken back later: the inverse changes, and every touched item as the commit left it. */
export interface UndoRecord { inverse: any[]; after: Record<string, string | null> }

const JOIN_TIMEOUT_MS = 20000, ACK_TIMEOUT_MS = 30000;
let opN = 0;

export class DocSession {
  kdoc: any = null;
  /** The snapshot the document was built from: its header is what a serialised copy starts with. */
  file = "";
  role = "viewer";
  lastUsed = Date.now();
  private ws: any = null;
  private lastSeq = 0;
  private joined = false;
  private opening: Promise<void> | null = null;
  private onSnapshot: (() => void)[] = [];
  private acks = new Map<string, { ok(seq: number): void; fail(e: Error): void }>();
  private presence: any = null;
  private beat: any = 0;
  /** Bumped whenever the document changes under us; readers that cache derived data key on it. */
  version = 0;

  constructor(readonly entry: DocEntry, private conn: Conn) {}

  get IU(): number { return this.entry.docType === "kicad_sch" ? 1e4 : 1e6; }
  get open(): boolean { return !!this.ws && this.ws.readyState === 1 && this.joined && !!this.kdoc; }

  /** Use the newest token: the one a socket was opened with only matters at the next reconnect. */
  touch(conn: Conn): void { this.conn = conn; this.lastUsed = Date.now(); }

  /** Joined, with the document in memory.  Reconnects when the socket went away since the last call. */
  ensure(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.ws && this.ws.readyState === 1 && this.joined) return Promise.resolve();   // a resync in flight is waited out by current()
    if (!this.opening) this.opening = this.connect().finally(() => { this.opening = null; });
    return this.opening;
  }

  private connect(): Promise<void> {
    this.close();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (err) { this.close(); reject(err); } else resolve(); };
      const timer = setTimeout(() => done(new ToolError(`The server did not open ${this.entry.path} in time. Try again.`)), JOIN_TIMEOUT_MS);
      let sock: any;
      try { sock = new W.WebSocket(this.conn.base.replace(/^http/, "ws") + "/ws"); } catch (e) { done(new ToolError("The collaboration server could not be reached.")); return; }
      this.ws = sock; this.joined = false; this.kdoc = null; this.lastSeq = 0;
      sock.onopen = () => sock.send(JSON.stringify({ type: "hello", proto: 1, token: this.conn.token, clientId: "mcp-" + Math.random().toString(36).slice(2, 10), linkToken: null, client: "mcp", agent: this.conn.agent }));
      sock.onerror = () => { if (this.ws === sock) done(new ToolError("The collaboration server could not be reached.")); };
      sock.onclose = () => {
        if (this.ws !== sock) return;
        this.ws = null; this.joined = false; clearInterval(this.beat);
        for (const a of this.acks.values()) a.fail(new ToolError("The connection to the server dropped before the change was confirmed. Read the document again to see whether it was applied."));
        this.acks.clear();
        done(new ToolError(`The connection closed while opening ${this.entry.path}.`));
      };
      sock.onmessage = (ev: any) => {
        if (this.ws !== sock) return;
        let msg: any; try { msg = JSON.parse(String(ev.data)); } catch { return; }
        switch (msg.type) {
          case "hello_ok": sock.send(JSON.stringify({ type: "join_doc", docId: this.entry.docId })); break;
          case "doc_info": this.joined = true; if (typeof msg.role === "string") this.role = msg.role; break;
          case "snapshot":
            if (typeof msg.file !== "string") break;
            try { this.load(msg.file, Number(msg.seq) || 0, msg.thenOps || []); } catch (e) { done(new ToolError(`${this.entry.path} could not be parsed.`)); break; }
            done(); for (const f of this.onSnapshot.splice(0)) f();
            break;
          case "op": this.remote(msg); break;
          case "ops": for (const op of msg.ops || []) if (!this.remote(op)) break; break;
          case "ack": { const a = msg.clientOpId && this.acks.get(msg.clientOpId); if (a) { this.acks.delete(msg.clientOpId); this.lastSeq = Math.max(this.lastSeq, Number(msg.seq) || 0); a.ok(Number(msg.seq) || 0); } break; }
          case "reset": this.resync(); break;
          case "error": {
            const a = msg.clientOpId && this.acks.get(msg.clientOpId);
            if (a) { this.acks.delete(msg.clientOpId); a.fail(new ToolError(refusal(msg.code))); this.resync(); }
            else if (msg.code === "desynced") this.resync();
            else if (msg.code === "auth_failed") done(new ToolError("The sign-in for this connection is no longer valid. Connect again."));
            else if (msg.code === "permission_denied" || msg.code === "not_found") { this.role = "none"; done(new ToolError(`You no longer have access to ${this.entry.path}.`)); this.close(); }
            break;
          }
          default: break;
        }
      };
    });
  }

  private load(file: string, seq: number, thenOps: any[]): void {
    const d = K().parseDoc(file, this.entry.docType);
    this.kdoc = d; this.file = file; this.lastSeq = seq; this.version++;
    for (const op of thenOps) { this.apply(op.changes || []); this.lastSeq = Math.max(this.lastSeq, Number(op.seq) || 0); }
  }

  /** A change somebody else made.  Returns false when it showed a gap and a fresh base was asked for. */
  private remote(op: any): boolean {
    const n = Number(op.seq) || 0;
    if (n && this.lastSeq && n <= this.lastSeq) return true;                        // already have it
    if (n && this.lastSeq && n > this.lastSeq + 1) { this.resync(); return false; }   // missed one: start over from the server's copy
    if (n) this.lastSeq = n;
    if (this.kdoc && !this.apply(op.changes || [])) this.resync();
    return true;
  }

  /** Apply changes to the in-memory document.  False when one could not be taken (the copies have diverged). */
  apply(changes: any[]): boolean {
    const k = K(), doc = this.kdoc; let any = false, dropped = false;
    for (const c of changes) {
      if (c && c.docProps) { if (k.applyDocProps(doc, c.docProps)) any = true; continue; }
      if (c && c.typeName === "BOARD_SETUP") { if (k.boardSetup && k.boardSetup.applyBoardSetup(doc, c)) any = true; continue; }
      let ok = false;
      try { ok = k.applyChange(doc, c, this.IU); } catch (e) { console.warn("mcp host: change not applied", e); }
      if (ok) any = true; else if (c && (c.sexpr || c.itemSexpr || String(c.kind).toUpperCase() === "ADDED")) dropped = true;
    }
    if (any) { if (doc.type !== "sch") k.computeBBox(doc); this.version++; }
    return !dropped;
  }

  private resync(): void {
    if (this.ws && this.ws.readyState === 1) { this.kdoc = null; this.ws.send(JSON.stringify({ type: "resync", docId: this.entry.docId })); }
  }

  /** The document as the server has it: waits out a resync that is under way. */
  async current(): Promise<any> {
    await this.ensure();
    if (!this.kdoc) await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new ToolError(`${this.entry.path} could not be reloaded from the server.`)), JOIN_TIMEOUT_MS);
      this.onSnapshot.push(() => { clearTimeout(t); resolve(); });
    });
    return this.kdoc;
  }

  private send(changes: any[]): Promise<number> {
    return new Promise<number>((ok, fail) => {
      if (!this.open) { fail(new ToolError("Not connected to the document.")); return; }
      const clientOpId = `mcp:${Date.now().toString(36)}:${++opN}`;
      const timer = setTimeout(() => { if (this.acks.delete(clientOpId)) fail(new ToolError("The server did not confirm the change in time. Read the document again to see whether it was applied.")); }, ACK_TIMEOUT_MS);
      this.acks.set(clientOpId, { ok: (seq) => { clearTimeout(timer); ok(seq); }, fail: (e) => { clearTimeout(timer); fail(e); } });
      this.ws.send(JSON.stringify({ type: "op", docId: this.entry.docId, clientOpId, baseSeq: null, changes }));
    });
  }

  /**
   * The editor's commit: apply here, send the op, wait for the server to accept it.  Returns what an undo needs.
   * When the server refuses the op the local copy is thrown away and reloaded, so nothing is left half applied.
   */
  async commit(changes: any[]): Promise<UndoRecord> {
    const k = K(), doc = this.kdoc; const inverse: any[] = [];
    for (const c of changes) {
      const it = doc.items.get(c.id);
      if (c.kind === "ADDED") inverse.push({ id: c.id, kind: "REMOVED", typeName: c.typeName, properties: [] });
      else if (it) inverse.push({ id: c.id, kind: c.kind === "REMOVED" ? "ADDED" : "MODIFIED", typeName: c.typeName, sexpr: k.serializeItem(doc, it) });
    }
    this.apply(changes);
    await this.send(changes);
    const after: Record<string, string | null> = {};
    for (const c of changes) { const it = doc.items.get(c.id); after[c.id] = it ? k.serialize(it.node) : null; }
    this.show(changes.map((c) => c.id));
    return { inverse: inverse.reverse(), after };
  }

  /** Tell the others where the work is: a cursor on what was just changed, with those items marked as this peer's selection. */
  private show(ids: string[]): void {
    const doc = this.kdoc; if (!doc) return; const IU = this.IU;
    const sel: string[] = [], boxes: number[][] = []; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      const b = doc.items.get(id)?.bbox; if (!b) continue;
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
      if (sel.length < 60) { sel.push(id); boxes.push([Math.round(b[0] * IU), Math.round(b[1] * IU), Math.round((b[2] - b[0]) * IU), Math.round((b[3] - b[1]) * IU)]); }
    }
    if (!isFinite(x0)) return;
    this.presence = { cursor: [Math.round(((x0 + x1) / 2) * IU), Math.round(((y0 + y1) / 2) * IU)], selection: sel, boxes, sheetFile: this.entry.path };
    this.sendPresence();
    // the server forgets a silent peer after 30 s; keep the mark up while this document stays open here
    clearInterval(this.beat);
    this.beat = setInterval(() => this.sendPresence(), 10000);
    if (this.beat && typeof this.beat.unref === "function") this.beat.unref();
  }
  private sendPresence(): void {
    if (this.open && this.presence) this.ws.send(JSON.stringify({ type: "presence", docId: this.entry.docId, state: this.presence }));
  }

  close(): void {
    clearInterval(this.beat);
    const s = this.ws; this.ws = null; this.joined = false;
    if (s) { try { s.onclose = null; s.close(); } catch { /* already closed */ } }
    for (const a of this.acks.values()) a.fail(new ToolError("The connection to the document was closed."));
    this.acks.clear();
  }
}

function refusal(code: string): string {
  if (code === "permission_denied") return "The server refused the change: you have view-only access to this project.";
  if (code === "bad_op") return "The server refused the change as malformed. Nothing was changed.";
  return `The server refused the change (${code || "error"}). Nothing was changed.`;
}

// ---------------------------------------------------------------- whole-file documents (.kicad_pro)

interface Live { file: string; seq: number; ops: any[]; role: string }

/** One short conversation with a document over its own socket: join, hand over the catch-up, optionally send an op. */
function withDocument<T>(conn: Conn, docId: string, onJoined: (live: Live, sendOp: (changes: any[]) => Promise<number>) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false, role = "viewer"; let sock: any = null;
    const acks = new Map<string, { ok(seq: number): void; fail(e: Error): void }>();
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { if (sock) sock.close(); } catch { /* closed */ } fn(); };
    const timer = setTimeout(() => done(() => reject(new Error("the server did not answer"))), JOIN_TIMEOUT_MS);
    const sendOp = (changes: any[]) => new Promise<number>((ok, fail) => {
      if (!sock || sock.readyState !== 1) { fail(new Error("not connected")); return; }
      const clientOpId = `mcp-file:${Date.now().toString(36)}:${++opN}`; acks.set(clientOpId, { ok, fail });
      sock.send(JSON.stringify({ type: "op", docId, clientOpId, baseSeq: null, changes }));
    });
    try { sock = new W.WebSocket(conn.base.replace(/^http/, "ws") + "/ws"); } catch (e) { done(() => reject(new Error("connection failed"))); return; }
    const s = sock;
    s.onopen = () => s.send(JSON.stringify({ type: "hello", proto: 1, token: conn.token, clientId: "mcp-file-" + Math.random().toString(36).slice(2, 10), linkToken: null, client: "mcp", agent: conn.agent }));
    s.onerror = () => done(() => reject(new Error("connection failed")));
    s.onclose = () => done(() => reject(new Error("connection closed")));
    s.onmessage = (ev: any) => {
      let msg: any; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "hello_ok") s.send(JSON.stringify({ type: "join_doc", docId }));
      else if (msg.type === "doc_info") role = msg.role || "viewer";
      else if (msg.type === "snapshot" && typeof msg.file === "string") onJoined({ file: msg.file, seq: Number(msg.seq) || 0, ops: msg.thenOps || [], role }, sendOp).then((v) => done(() => resolve(v)), (e) => done(() => reject(e instanceof Error ? e : new Error(String(e)))));
      else if (msg.type === "ack" && msg.clientOpId && acks.has(msg.clientOpId)) { const a = acks.get(msg.clientOpId)!; acks.delete(msg.clientOpId); a.ok(Number(msg.seq) || 0); }
      else if (msg.type === "error") { const a = msg.clientOpId ? acks.get(msg.clientOpId) : undefined; if (a) a.fail(new Error(msg.code || "refused")); else done(() => reject(new Error(msg.code || "refused"))); }
    };
  });
}

/** A whole-file document in its current state: the newest snapshot with the value edits journalled after it laid over. */
export async function readTextDocument(conn: Conn, docId: string): Promise<string> {
  const live = await withDocument(conn, docId, (l) => Promise.resolve(l));
  const edits: { path: string[]; value: any }[] = [];
  for (const op of live.ops) for (const c of op.changes || []) {
    if (c.typeName !== "PROJECT_FILE") continue;
    for (const p of c.properties || []) if (p.after && p.name) edits.push({ path: String(p.name).split("."), value: p.after.v });
  }
  if (!edits.length) return live.file;
  try { return K().projectFile.editProject(live.file, edits).text; } catch { return live.file; }
}

/** The dotted paths at which two plain JSON values differ, with the new value at each (arrays are compared whole). */
export function jsonDiff(a: any, b: any, path: string[] = [], out: { path: string[]; value: any }[] = []): { path: string[]; value: any }[] {
  const obj = (v: any) => v && typeof v === "object" && !Array.isArray(v);
  if (obj(a) && obj(b)) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (k in b) jsonDiff(a[k], b[k], [...path, k], out); } return out; }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, value: b });
  return out;
}

/**
 * Change the project file: `mutate` edits the parsed settings, and only the values it changed are written, so the
 * rest of the file keeps KiCad's own formatting.  Stored the way the editor stores it: an op that records the
 * edit, then the new file as the snapshot at that op.
 */
export async function editProjectFile(conn: Conn, docId: string, mutate: (pro: any) => void, label: string): Promise<{ text: string; changed: number }> {
  const before = await readTextDocument(conn, docId);
  const was = JSON.parse(before), now = JSON.parse(before); mutate(now);
  const edits = jsonDiff(was, now); if (!edits.length) return { text: before, changed: 0 };
  const res = K().projectFile.editProject(before, edits);
  const ok = await withDocument(conn, docId, async (live, sendOp) => {
    if (live.role !== "editor") throw new ToolError("You have view-only access to this project.");
    const seq = await sendOp([{ id: "project", kind: "MODIFIED", typeName: "PROJECT_FILE", note: label, properties: res.changed.map((e: any) => ({ name: e.path.join("."), after: { type: "json", v: e.value } })) }]);
    const r = await W.fetch(`/api/docs/${docId}/snapshots?seq=${seq}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: res.text });
    return r.ok;
  });
  if (!ok) throw new ToolError("The project file could not be saved.");
  return { text: res.text, changed: res.changed.length };
}
