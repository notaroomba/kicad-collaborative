// symedit/libdoc.ts — one project symbol library (.kicad_sym) as a live, shared document: KiCad's library manager
// buffer (LIB_SYMBOL_LIBRARY_MANAGER), held by every client that has the library open.
//
// The library joins its document's socket (the protocol's ordinary join, as editor/projectwatch.ts does for the
// project file).  A working edit is an op on that document whose changes are whole top-level symbols:
//     { id: "sym:<name>", kind: "ADDED" | "MODIFIED" | "REMOVED", typeName: "LIB_SYMBOL", sexpr: "(symbol \"<name>\" …)", base?: "…" }
// An edit of one symbol carries `base`, the symbol's text it was made against: a client applying it to a symbol that
// has changed since (another user's edit sequenced in between) carries over only the edit's own item changes
// (symedit/merge.ts), so concurrent edits both survive and an undo takes back only its own user's change.
// (a rename or a delete with derived symbols is one op holding several changes).  Every peer applies it to its own
// copy of the library, so everyone sees the same buffer and the same '*' modified markers.  The file itself — what
// the desktop and the content route read — changes only on Save: a marker op { typeName: "LIB_SAVED" } and then the
// whole library text uploaded as the snapshot at that op's sequence number (editor/projectfile.ts saveTextDocument).
// A symbol is modified while its text differs from the saved file's; Revert sends the ops that put the saved text back.
//
// Local ops are applied at once and kept until acknowledged; a remote op is applied and the unacknowledged local
// ones are laid over it again (editor/net.ts reapplyPending), so every client converges on the server's order.
import { parseLibrary, serializeLibrary, text, node, NEW_LIBRARY_TEXT, type SymLib } from "./model";
import { mergeSymbolText } from "./merge";

export interface LibChange { id: string; kind: "ADDED" | "MODIFIED" | "REMOVED"; typeName: "LIB_SYMBOL" | "LIB_SAVED"; sexpr?: string; base?: string; properties?: unknown[] }
interface OpMsg { seq?: number; changes?: LibChange[] }
interface WireMsg { type?: string; docId?: string; seq?: number; file?: string; thenOps?: OpMsg[]; ops?: OpMsg[]; changes?: LibChange[]; clientOpId?: string; role?: string; code?: string }

const symId = (name: string) => "sym:" + name;
let opN = 0;

export type LibListener = (why: "load" | "remote" | "local" | "saved" | "role" | "error", names?: string[]) => void;

export class LibDoc {
  readonly docId: string; readonly path: string; nickname: string;
  /** the file as last saved (the newest snapshot) */
  saved: SymLib = parseLibrary(NEW_LIBRARY_TEXT);
  /** the shared working buffer as this client sees it: the server's buffer plus our unacknowledged edits */
  lib: SymLib = parseLibrary(NEW_LIBRARY_TEXT);
  /** the server's buffer: every op it has sequenced (symbol nodes are replaced, never changed in place, so the two share them) */
  private confirmed: SymLib = parseLibrary(NEW_LIBRARY_TEXT);
  role = "viewer"; loaded = false; error: string | null = null;
  private sock: WebSocket | null = null; private gen = 0; private retries = 0;
  private pending = new Map<string, { changes: LibChange[]; resolve(seq: number): void; reject(e: Error): void; onAck?: () => void }>();
  private listeners = new Set<LibListener>();
  private clientId = "web-lib-" + Math.random().toString(36).slice(2, 10);
  private ready: Promise<void>; private readyResolve!: () => void;
  lastSeq = 0;

  constructor(docId: string, path: string, nickname: string) {
    this.docId = docId; this.path = path; this.nickname = nickname;
    this.ready = new Promise((r) => { this.readyResolve = r; });
  }
  on(fn: LibListener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(why: Parameters<LibListener>[0], names?: string[]): void { for (const f of Array.from(this.listeners)) { try { f(why, names); } catch (e) { console.error(e); } } }
  whenLoaded(): Promise<void> { return this.ready; }
  get canEdit(): boolean { return this.role === "editor"; }

  // ------------------------------------------------------------ state
  symbolText(name: string, which: "lib" | "saved" = "lib"): string | null { const s = (which === "lib" ? this.lib : this.saved).symbols.get(name); return s ? text(s) : null; }
  isSymbolModified(name: string): boolean { return this.symbolText(name) !== this.symbolText(name, "saved"); }
  modifiedNames(): string[] {
    const out = new Set<string>();
    for (const n of this.lib.symbols.keys()) if (this.isSymbolModified(n)) out.add(n);
    for (const n of this.saved.symbols.keys()) if (!this.lib.symbols.has(n)) out.add(n);
    return Array.from(out);
  }
  get isModified(): boolean { return this.modifiedNames().length > 0; }
  /** The file Save would write. */
  fileText(): string { return serializeLibrary(this.lib); }

  /** Apply changes to a buffer (no network). */
  private applyLocal(changes: LibChange[], to: SymLib = this.lib): string[] {
    const names: string[] = [];
    for (const c of changes) {
      if (c.typeName !== "LIB_SYMBOL") continue;
      const name = c.id.startsWith("sym:") ? c.id.slice(4) : c.id; names.push(name);
      if (c.kind === "REMOVED") to.symbols.delete(name);
      else if (c.sexpr) {
        try {
          const cur = to.symbols.get(name);
          let t = c.sexpr;
          if (c.base && cur) { const ct = text(cur); if (ct !== c.base) t = mergeSymbolText(c.base, c.sexpr, ct, node); }
          to.symbols.set(name, node(t));
        } catch (e) { console.warn("bad LIB_SYMBOL change", e); }
      }
    }
    return names;
  }
  private onSaved(): void { this.saved = { head: this.confirmed.head, version: this.confirmed.version, symbols: new Map(this.confirmed.symbols) }; }
  /** lib = confirmed + the unacknowledged local edits. */
  private rebase(): string[] {
    this.lib = { head: this.confirmed.head, version: this.confirmed.version, symbols: new Map(this.confirmed.symbols) };
    const names: string[] = []; for (const p of this.pending.values()) names.push(...this.applyLocal(p.changes));
    return names;
  }

  // ------------------------------------------------------------ edits
  /**
   * Change = the new whole symbols (null removes), each optionally with the text the edit was made against (merged
   * over whatever the symbol holds when the op is applied); sends one op.  Resolves with its sequence number.
   */
  commit(symbols: ([string, string | null] | [string, string, string])[], extraRemoved: string[] = []): Promise<number> {
    const changes: LibChange[] = [];
    for (const n of extraRemoved) if (this.lib.symbols.has(n)) changes.push({ id: symId(n), kind: "REMOVED", typeName: "LIB_SYMBOL", properties: [] });
    for (const [n, t, base] of symbols) {
      if (t === null) { if (this.lib.symbols.has(n)) changes.push({ id: symId(n), kind: "REMOVED", typeName: "LIB_SYMBOL", properties: [] }); }
      else { const c: LibChange = { id: symId(n), kind: this.lib.symbols.has(n) ? "MODIFIED" : "ADDED", typeName: "LIB_SYMBOL", sexpr: t }; if (base && this.lib.symbols.has(n)) c.base = base; changes.push(c); }
    }
    if (!changes.length) return Promise.resolve(this.lastSeq);
    const names = this.applyLocal(changes);
    this.emit("local", names);
    return this.send(changes);
  }
  private send(changes: LibChange[], onAck?: () => void): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const clientOpId = `web-lib:${Date.now().toString(36)}:${++opN}`;
      this.pending.set(clientOpId, { changes, resolve, reject, onAck });
      const s = this.sock;
      if (s && s.readyState === 1) s.send(JSON.stringify({ type: "op", docId: this.docId, clientOpId, baseSeq: null, changes }));
      // otherwise sent on (re)join
    });
  }
  /** Save: the LIB_SAVED marker op, then the whole file as the snapshot at its sequence number. */
  async save(): Promise<boolean> {
    let textNow = "";
    // the file is the server's buffer at the marker's sequence number: taken when the marker is acknowledged
    await this.send([{ id: "lib", kind: "MODIFIED", typeName: "LIB_SAVED", properties: [] }], () => { textNow = serializeLibrary(this.confirmed); });
    const seq = this.lastSeq;
    const r = await fetch(`/api/docs/${this.docId}/snapshots?seq=${seq}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: textNow });
    if (!r.ok) return false;
    this.emit("saved");
    return true;
  }
  /** Revert: every symbol back to the saved file's text, in one op. */
  revert(names?: string[]): Promise<number> {
    const list = names || this.modifiedNames();
    const out: [string, string | null][] = list.map((n) => [n, this.symbolText(n, "saved")]);
    return this.commit(out);
  }

  // ------------------------------------------------------------ socket
  connect(): void { void this.open(); }
  close(): void { this.gen++; const s = this.sock; this.sock = null; if (s) { s.onclose = null; try { s.close(); } catch (e) { /* closed */ } } }
  private async open(): Promise<void> {
    const my = ++this.gen; let token = "";
    try { const r = await fetch("/api/ws-ticket", { credentials: "same-origin" }); if (r.ok) token = ((await r.json()) as { token?: string }).token || ""; } catch (e) { /* signed out */ }
    if (my !== this.gen) return;
    if (!token) { await this.loadReadOnly(); return; }
    let s: WebSocket;
    try { s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`); } catch (e) { await this.loadReadOnly(); return; }
    this.sock = s;
    s.onopen = () => s.send(JSON.stringify({ type: "hello", proto: 1, token, clientId: this.clientId, linkToken: null, client: "web" }));
    s.onclose = () => {
      if (this.sock !== s || my !== this.gen) return; this.sock = null;
      const delay = Math.min(15000, 1000 * Math.pow(2, this.retries++));
      setTimeout(() => { if (my === this.gen && !this.sock) void this.open(); }, delay);
    };
    s.onmessage = (ev) => {
      if (this.sock !== s) return;
      let msg: WireMsg; try { msg = JSON.parse(String(ev.data)) as WireMsg; } catch (e) { return; }
      if (msg.docId && msg.docId !== this.docId) return;
      if (msg.type === "hello_ok") { const m = msg as WireMsg & { clientId?: string }; if (m.clientId) this.clientId = m.clientId; s.send(JSON.stringify({ type: "join_doc", docId: this.docId })); }
      else if (msg.type === "doc_info") { if (typeof msg.role === "string") { this.role = msg.role; this.emit("role"); } }
      else if (msg.type === "role" && typeof msg.role === "string") { this.role = msg.role; this.emit("role"); }
      else if (msg.type === "snapshot" && typeof msg.file === "string") this.onSnapshot(msg.file, Number(msg.seq) || 0, msg.thenOps || []);
      else if (msg.type === "ack" && msg.clientOpId) {
        const p = this.pending.get(msg.clientOpId); this.lastSeq = Math.max(this.lastSeq, Number(msg.seq) || 0);
        if (p) {
          this.pending.delete(msg.clientOpId);
          if (p.changes.some((c) => c.typeName === "LIB_SAVED")) { this.onSaved(); if (p.onAck) p.onAck(); }
          else this.applyLocal(p.changes, this.confirmed);
          p.resolve(Number(msg.seq) || 0);
        }
      }
      else if (msg.type === "op") this.onRemote([{ seq: msg.seq, changes: msg.changes }]);
      else if (msg.type === "ops") this.onRemote(msg.ops || []);
      else if (msg.type === "reset") { s.send(JSON.stringify({ type: "join_doc", docId: this.docId })); }
      else if (msg.type === "error") {
        const p = msg.clientOpId ? this.pending.get(msg.clientOpId) : undefined;
        if (p) { this.pending.delete(msg.clientOpId!); p.reject(new Error(msg.code || "refused")); this.resync(); }
        else if (msg.code === "auth_failed" || msg.code === "permission_denied" || msg.code === "not_found") { this.error = msg.code || "error"; this.emit("error"); }
      }
    };
  }
  private resync(): void { const s = this.sock; if (s && s.readyState === 1) s.send(JSON.stringify({ type: "join_doc", docId: this.docId })); }
  /** A signed-out viewer: the saved file alone. */
  private async loadReadOnly(): Promise<void> {
    try { const r = await fetch(`/api/docs/${this.docId}/content`, { credentials: "same-origin" }); if (r.ok) this.onSnapshot(await r.text(), 0, []); else { this.error = `HTTP ${r.status}`; this.emit("error"); } }
    catch (e) { this.error = String(e); this.emit("error"); }
  }
  private onSnapshot(file: string, seq: number, ops: OpMsg[]): void {
    this.retries = 0;
    try { this.saved = parseLibrary(file); } catch (e) { this.saved = parseLibrary(NEW_LIBRARY_TEXT); }
    this.confirmed = { head: this.saved.head, version: this.saved.version, symbols: new Map(this.saved.symbols) };
    this.lastSeq = seq;
    this.replay(ops);
    this.rebase();
    // ops sent while the socket was down (or refused and resynced) go out again, laid over what the server has
    for (const [id, p] of this.pending) { const s = this.sock; if (s && s.readyState === 1) s.send(JSON.stringify({ type: "op", docId: this.docId, clientOpId: id, baseSeq: null, changes: p.changes })); }
    const first = !this.loaded; this.loaded = true;
    if (first) this.readyResolve();
    this.emit("load");
  }
  private replay(ops: OpMsg[]): void {
    for (const o of ops) {
      this.lastSeq = Math.max(this.lastSeq, Number(o.seq) || 0);
      const ch = o.changes || [];
      if (ch.some((c) => c.typeName === "LIB_SAVED")) { this.onSaved(); continue; }
      this.applyLocal(ch, this.confirmed);
    }
  }
  private onRemote(ops: OpMsg[]): void {
    const fresh = ops.filter((o) => !(Number(o.seq) <= this.lastSeq));
    if (!fresh.length) return;
    const names: string[] = []; let saved = false;
    for (const o of fresh) {
      this.lastSeq = Math.max(this.lastSeq, Number(o.seq) || 0);
      const ch = o.changes || [];
      // a peer's Save: the file it uploads is the server's buffer at that op, which every client holds the same
      if (ch.some((c) => c.typeName === "LIB_SAVED")) { this.onSaved(); saved = true; continue; }
      names.push(...this.applyLocal(ch, this.confirmed));
    }
    // our unacknowledged edits stay on top (the server sequences them after what we just received); the listeners
    // hear only the symbols the remote ops changed (a pending local rename is not someone else's delete)
    const local = this.rebase();
    if (saved) this.emit("saved");
    if (names.length || local.length) this.emit("remote", names);
  }
}

// ---------------------------------------------------------------- the open libraries of the page
const open = new Map<string, LibDoc>();
export function libDocFor(docId: string, path: string, nickname: string): LibDoc {
  let d = open.get(docId);
  if (!d) { d = new LibDoc(docId, path, nickname); open.set(docId, d); d.connect(); }
  else d.nickname = nickname;
  return d;
}
export function openLibDocs(): LibDoc[] { return Array.from(open.values()); }
export function closeAllLibDocs(): void { for (const d of open.values()) d.close(); open.clear(); }
