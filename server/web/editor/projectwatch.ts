// editor/projectwatch — the project file (.kicad_pro) kept live while a project is open in the editor.
//
// Every writer of the project file (Schematic Setup, Board Setup, the pre-defined sizes, the layer pair presets,
// the BOM presets) stores it the same way: one op on the .kicad_pro document, then the new text uploaded as that
// document's snapshot at the op's sequence number (see projectfile.ts and dialogs/project.ts).  The editor's own
// socket joins only the open sheet or board, so another browser used to see such a change only after a reload.
//
// This module holds a second, quiet socket joined to the project's .kicad_pro document — the protocol's ordinary
// join, nothing new on the wire.  An op there names the sequence number whose snapshot carries the new file; the
// snapshot is fetched (it is uploaded right after the op is acknowledged, so a few short retries cover the gap)
// and the editor adopts it: design rules, netclasses and the size selectors on a board, the layer pair presets,
// text variables, the schematic's drawing settings and ERC severities.  When no snapshot arrives (a writer that
// stopped half way) the values the op itself names are laid over the current text, as a joining client would.
// A `reset` (a checkpoint restored) re-reads the whole file.  Signed-out viewers have no socket and keep the
// file they loaded.
import { state, store } from "./appstore";
import { adoptProjectFile } from "./projectfile";
import { adoptRoutingProject } from "./pcbrouting";
import { E } from "./state";
import { api } from "./util";
import { adoptProject } from "../dialogs/project";
import { editProject, type Plain, type ProjectEdit } from "../canvas/project-file";

interface Change { typeName?: string; properties?: { name?: string; after?: { v?: unknown } | null }[] }
interface OpMsg { seq?: number; changes?: Change[] }
interface WatchMsg { type?: string; docId?: string; seq?: number; file?: string; thenOps?: OpMsg[]; ops?: OpMsg[]; changes?: Change[]; code?: string }
interface ProDocEntry { docId: string; docType: string }

let watchedDoc: string | null = null;
let sock: WebSocket | null = null;
let gen = 0, retries = 0, lastSeq = 0;
const clientId = "web-pro-" + Math.random().toString(36).slice(2, 10);

/** The values an op on the project file names, as edits (PROJECT_FILE changes carry them; marker ops do not). */
export function opEdits(changes: readonly Change[] | undefined): ProjectEdit[] {
  const out: ProjectEdit[] = [];
  for (const c of changes || []) {
    if (!c || c.typeName !== "PROJECT_FILE") continue;
    for (const p of c.properties || []) if (p && p.name && p.after && "v" in p.after) out.push({ path: p.name.split("."), value: p.after.v as Plain });
  }
  return out;
}

/** Hand a project file to everything in the editor that reads one. */
export function adoptProjectText(text: string): void {
  if (!text || text === E.proSettings) return;
  try { JSON.parse(text); } catch (e) { return; }           // never adopt a torn upload
  adoptProjectFile(text);                                     // rules, size lists, text variables
  adoptRoutingProject(text);                                  // layer pair presets
  adoptProject(text);                                         // schematic settings, ERC, listeners
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function fetchSnapshot(docId: string, seq: number): Promise<string | null> {
  for (const ms of [0, 120, 250, 500, 1000, 2000, 3000]) {
    if (ms) await wait(ms);
    if (watchedDoc !== docId) return null;
    const r = await fetch(`/api/docs/${docId}/snapshots/${seq}`, { credentials: "same-origin" }).catch(() => null);
    if (r && r.ok) return r.text();
    if (r && r.status !== 404) return null;
  }
  return null;
}

let chain: Promise<void> = Promise.resolve();
/** Ops are taken in order: a slow fetch for one must not let an older file land after a newer one. */
function onOps(docId: string, ops: OpMsg[]): void {
  const fresh = ops.filter((o) => Number(o.seq) > lastSeq);
  if (!fresh.length) return;
  lastSeq = Math.max(lastSeq, ...fresh.map((o) => Number(o.seq) || 0));
  const last = fresh[fresh.length - 1];
  chain = chain.then(async () => {
    const text = await fetchSnapshot(docId, Number(last.seq));
    if (watchedDoc !== docId) return;
    if (text !== null) { adoptProjectText(text); return; }
    const edits = fresh.flatMap((o) => opEdits(o.changes));
    if (edits.length && E.proSettings) { try { adoptProjectText(editProject(E.proSettings, edits).text); } catch (e) { /* keep what we have */ } }
  }).catch(() => { /* the next op tries again */ });
}

function reread(docId: string): void {
  chain = chain.then(async () => {
    const t = await (api(`/api/docs/${docId}/content?v=${Date.now()}`) as Promise<unknown>).catch(() => null);
    if (watchedDoc === docId && t !== null) adoptProjectText(typeof t === "string" ? t : JSON.stringify(t));
  });
}

function close(): void {
  gen++;
  const s = sock; sock = null;
  if (s) { s.onclose = null; try { s.close(); } catch (e) { /* closed */ } }
}

async function open(docId: string): Promise<void> {
  const my = ++gen;
  let token = "";
  try { token = ((await api("/api/ws-ticket")) as { token?: string }).token || ""; } catch (e) { return; }
  if (my !== gen || watchedDoc !== docId) return;
  let s: WebSocket;
  try { s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`); } catch (e) { return; }
  sock = s;
  let joined = false;
  s.onopen = () => s.send(JSON.stringify({ type: "hello", proto: 1, token, clientId, linkToken: null, client: "web" }));
  s.onclose = () => {
    if (sock !== s || my !== gen) return;
    sock = null;
    const delay = Math.min(30000, 1000 * Math.pow(2, retries++));
    setTimeout(() => { if (my === gen && watchedDoc === docId && !sock) void open(docId); }, delay);
  };
  s.onmessage = (ev) => {
    if (sock !== s) return;
    let msg: WatchMsg;
    try { msg = JSON.parse(String(ev.data)) as WatchMsg; } catch (e) { return; }
    if (msg.type === "hello_ok") s.send(JSON.stringify({ type: "join_doc", docId }));
    else if (msg.type === "error" && (msg.code === "auth_failed" || msg.code === "permission_denied" || msg.code === "not_found")) { s.onclose = null; sock = null; try { s.close(); } catch (e) { /* closed */ } }
    else if (msg.docId && msg.docId !== docId) return;
    else if (msg.type === "snapshot" && typeof msg.file === "string") {
      retries = 0;
      const ops = msg.thenOps || [];
      const head = Math.max(Number(msg.seq) || 0, ...ops.map((o) => Number(o.seq) || 0));
      // the first join only learns where the file stands (the editor loaded it already); a rejoin catches up
      if (joined && head > lastSeq) { const edits = ops.flatMap((o) => opEdits(o.changes)); let text = msg.file; if (edits.length) { try { text = editProject(text, edits).text; } catch (e) { /* the snapshot alone */ } } adoptProjectText(text); }
      joined = true; lastSeq = Math.max(lastSeq, head);
    }
    else if (msg.type === "op") onOps(docId, [{ seq: msg.seq, changes: msg.changes }]);
    else if (msg.type === "ops") onOps(docId, msg.ops || []);
    else if (msg.type === "reset") { lastSeq = Math.max(lastSeq, Number(msg.seq) || 0); reread(docId); }
  };
}

/** Follow the store: watch the open project's .kicad_pro while the editor shows it to a signed-in user. */
function sync(): void {
  const st = state as unknown as { view?: string; me?: unknown; project?: { docs?: ProDocEntry[] } | null };
  const pro = st.view === "editor" && st.me && st.project && Array.isArray(st.project.docs) ? st.project.docs.find((d) => d.docType === "kicad_pro") : undefined;
  const want = pro ? pro.docId : null;
  if (want === watchedDoc) return;
  close();
  watchedDoc = want; lastSeq = 0; retries = 0; chain = Promise.resolve();
  if (want) void open(want);
}

export function installProjectWatch(): void { store.subscribe(sync); sync(); }
