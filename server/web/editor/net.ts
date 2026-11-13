// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import { state, store } from "./appstore";
import { noteCommentMsg } from "./comments";
import { applyChanges, applyRemoteChanges, renderObjects, setDocFromText } from "./doc";
import { applyFollowWeb, renderPeers, startPresenceKeepalive } from "./peers";
import { drawSelection, renderProps } from "./selection";
import { E } from "./state";
import { setTool } from "./tools";
import { api, toast } from "./util";
import { historyActive, holdViewOnly, noteEdit, onVersionsNotice } from "./versions";
import type { ItemSummary, PendingOp, ServerError } from "./types";
import { dragG, drawPeers, peersG, scheduleRenderRefresh } from "./view";
import { updateTitle } from "./title";
// ---- websocket / presence / ops ----
export function setConn(cls: string, text?: string) { store.slice("connection", { status: cls === "live" ? "live" : cls === "err" ? "error" : "offline", text: text || (cls === "live" ? "live" : "offline") }); }

export function setViewOnly(v: boolean) { if (holdViewOnly(v)) return; E.viewOnly = !!v; store.set({ viewOnly: E.viewOnly }); }
/** The role the server says we hold on the open document: what the tools and the comment box follow. */
export function setRole(role: string | null) {
  const was = state.role;
  state.role = role;
  // While an earlier version is on screen (editor/versions.ts) the canvas stays read-only; the role is put back on leaving.
  const vo = !state.me || role !== "editor";
  if (!holdViewOnly(vo)) E.viewOnly = vo;
  E.canComment = !!state.me && (role === "editor" || role === "commenter");
  const can = { ...(store.get().can || { copy: true, share: false, manage: false }), edit: !E.viewOnly, comment: E.canComment };
  store.set({ role, viewOnly: E.viewOnly, canComment: E.canComment, can });
  return was;
}
/** How the status bar words the access: "live", "live · comment-only", "live · view-only". */
export function liveLabel() { return (E.history ? E.history.viewOnly : E.viewOnly) ? (E.canComment ? "live · comment-only" : "live · view-only") : "live"; }

   // bumped by every connect()/leaveDoc(); a stale socket's events are ignored
export async function connect() {
  const gen = ++E.connectGen;
  setConn("err", E.retries ? `reconnecting…` : "connecting…");
  // A cookie riding the WS upgrade is unreliable (SameSite / tracking
  // protection / proxies), so authenticate the socket with a token fetched
  // over a normal request and sent in the hello frame, like the desktop.
  let ticket: string;
  try {
    // A guest (not signed in) has no ticket to fetch: the server lets them watch what a public
    // project or an opened share link shows.
    ticket = state.me ? (await api("/api/ws-ticket")).token || "" : "";
  } catch (e) {
    if (gen !== E.connectGen) return;
    // Only a refused ticket means the sign-in is gone (a bad ticket would just loop; wait for a
    // reload).  A server that is down or redeploying (network error, 5xx) comes back, so retry
    // with the same backoff as a dropped socket — the desktop reconnects on its own too.
    if (/^40[13] /.test(String(e && (e as Error).message))) { setConn("err", "sign-in expired — reload to reconnect"); return; }
    const delay = Math.min(15000, 1000 * Math.pow(2, E.retries++));
    setConn("err", `reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => { if (state.view === "editor" && gen === E.connectGen) connect().catch(() => {}); }, delay);
    return;
  }
  if (gen !== E.connectGen || state.view !== "editor") return;   // the document changed while we waited
  E.wsToken = ticket;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let sock: WebSocket;
  try { sock = new WebSocket(`${proto}://${location.host}/ws`); }
  catch (e) { setConn("err", "connection blocked (VPN or proxy?)"); return; }
  E.ws = sock;
  E.joinedDocId = null;   // ops wait for doc_info: an op sent before the join is refused outright
  // A proxy that accepts the upgrade but never relays frames leaves the socket
  // open and silent; treat "no hello_ok" as a failure and retry rather than
  // sitting on the initial label forever.
  let handshakeDone = false;
  const watchdog = setTimeout(() => {
    if (E.ws !== sock || handshakeDone) return;
    console.warn("collab socket: no answer to hello within 8s (VPN/proxy?)");
    setConn("err", "no answer from server (VPN or proxy?) — retrying");
    sock.close();
  }, 8000);
  sock.onopen = () => { if (E.ws !== sock) return;
    // Keep the id across reconnects (the desktop does the same): the actor recognises the
    // same client and takes its entry over in place, instead of leaving a frozen ghost
    // cursor behind, and the server's op dedup key (docId, clientId, clientOpId) keeps
    // working, so replaying an unacknowledged op cannot apply it twice.
    if (!E.myClientId) E.myClientId = "web-" + Math.random().toString(36).slice(2, 10);
    sock.send(JSON.stringify({ type: "hello", proto: 1, token: E.wsToken, clientId: E.myClientId, linkToken: null, client: "web" })); };
  sock.onclose = (ev) => {
    clearTimeout(watchdog);
    console.warn(`collab socket closed: code=${ev.code} clean=${ev.wasClean} reason=${JSON.stringify(ev.reason || "")}`);
    if (E.ws !== sock || gen !== E.connectGen) return;   // superseded: not ours to reconnect
    E.ws = null; E.joinedDocId = null;
    peersG.replaceChildren(); E.peerState = {}; renderPeers();
    const delay = Math.min(15000, 1000 * Math.pow(2, E.retries++));
    setConn("err", `reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => { if (state.view === "editor" && gen === E.connectGen) connect().catch(() => {}); }, delay);
  };
  sock.onmessage = (ev) => {
    if (E.ws !== sock) return;
    const msg = JSON.parse(ev.data);
    if (msg.type === "error") console.warn("collab server error:", msg.code, msg.docId || "");
    if (msg.type === "hello_ok") {
      handshakeDone = true; clearTimeout(watchdog); E.retries = 0;
      // Adopt the id the server assigned (it namespaces ours by user id); sending our own
      // back on the next reconnect is what makes the takeover work.
      if (msg.clientId) E.myClientId = msg.clientId;
      sock.send(JSON.stringify({ type: "join_doc", docId: state.docId }));
    }
    if (msg.type === "error" && (msg.code === "bad_message" || msg.code === "unsupported_protocol")) { setConn("err", `server refused the session (${msg.code}) — reload`); }
    if (msg.type === "error" && msg.code === "auth_failed") {
      sock.onclose = null; sock.close(); if (E.ws === sock) E.ws = null;
      setConn("err", "sign-in expired — reload to reconnect");
    }
    if (msg.type === "doc_info") {
      E.peerState = {}; E.joinedDocId = msg.docId || state.docId;
      // doc_info's role is the server's answer, and it is re-sent on every rejoin — so a
      // demotion mid-session takes effect, and a session that was flipped read-only by a
      // refused op recovers on the next join instead of staying read-only for good.
      if (typeof msg.role === "string") setRole(msg.role);
      setConn("live", liveLabel()); renderPeers(); startPresenceKeepalive();
    }
    if (msg.type === "presence") { for (const [cid, e] of Object.entries(msg.peers || {})) { if (cid === E.myClientId || cid.endsWith(":" + E.myClientId)) continue; if (e === null) delete E.peerState[cid]; else E.peerState[cid] = e; }
      drawPeers(E.peerState); applyFollowWeb(E.peerState); renderPeers(); }
    if (msg.type === "peer_left" && msg.clientId) { delete E.peerState[msg.clientId]; drawPeers(E.peerState); applyFollowWeb(E.peerState); renderPeers(); }
    // Our own ops are acked, never broadcast back to us, so the ack is how their seq enters our
    // count — without it the next remote op would read as a gap and trigger a needless resync.
    if (msg.type === "ack" && msg.clientOpId) { E.pendingOps.delete(msg.clientOpId); E.lastSeq = Math.max(E.lastSeq, Number(msg.seq) || 0); updateTitle(); }
    if (msg.type === "error" && (msg.code === "permission_denied" || msg.code === "bad_op" || msg.code === "internal" || msg.code === "not_found")) onOpRejected(sock, msg);
    if (msg.type === "error" && msg.code === "desynced") requestResync(sock, true);
    if (msg.type === "error" && msg.code === "no_desktop") toast("Nobody has this board open in the desktop app, so zones keep their last fill. They refill as soon as someone opens it there.", 5000);
    if (msg.type === "error" && msg.code === "request_refused") toast("Only editors can ask for a refill");
    // The owner changed our role while the document is open: the tools follow at once.
    if (msg.type === "role" && typeof msg.role === "string" && (!msg.docId || msg.docId === state.docId)) {
      const was = setRole(msg.role);
      if (E.viewOnly) { E.drag = null; dragG.replaceChildren(); if (E.tool !== "select" && E.tool !== "pan") setTool("select"); }
      if (!E.canComment && E.tool === "comment") setTool("select");
      setConn("live", liveLabel()); renderProps();
      if (was !== msg.role) toast(msg.role === "editor" ? "You can now edit this project" : msg.role === "commenter" ? "You can now comment on this project, but not change it" : "You now have view-only access to this project", 4500);
    }
    if (msg.type === "comment") noteCommentMsg(msg);
    if (msg.type === "versions") onVersionsNotice(msg);       // somebody saved, restored, branched or merged
    // a document of the project was saved explicitly (the Footprint Editor's Save): fpedit.ts clears its '*', library caches drop the file
    if (msg.type === "saved") window.dispatchEvent(new CustomEvent("kc-doc-saved", { detail: msg }));
    // An earlier version is on screen (editor/versions.ts): the live stream is not laid over it.  Leaving the
    // timeline asks for the document again, so nothing that arrives meanwhile is lost.
    if (historyActive() && (msg.type === "snapshot" || msg.type === "op" || msg.type === "ops" || msg.type === "reset")) {
      if (msg.type === "op") { E.editsSeen++; bumpEdits(); }
      return;
    }
    if (msg.type === "snapshot" && msg.docId === state.docId && typeof msg.file === "string") {
      // The join's snapshot is nearly always the very text the page was just drawn from (doc.ts openDoc), and
      // nothing has been edited since: parsing and drawing it a second time only made the sheet stutter as
      // it appeared.  Anything else (a resync, a reconnect, an edit made before the join) takes the snapshot.
      const same = E.loadedText !== null && E.loadedText === msg.file && E.loadedOpN === E.opN && !!E.kdoc;
      E.loadedText = null;
      const then: { seq: number; changes: KChange[] }[] = msg.thenOps || [];
      const flat = (ops: { changes: KChange[] }[]) => { const out: KChange[] = []; for (const op of ops) for (const c of op.changes || []) out.push(c); return out; };
      // The edits since the snapshot go in as one change, not one pass (and one repaint's worth of work) each:
      // a project that only browsers and scripts edit carries its whole history there.
      let ok = true;
      if (same) applyChanges(flat(then.filter((op) => !(Number(op.seq) <= E.loadedSeq))));   // the ones openDoc had not fetched yet
      else ok = setDocFromText(msg.file, flat(then));
      if (ok) {
        E.lastSeq = then.length ? Number(then[then.length - 1].seq) || Number(msg.seq) || 0 : Number(msg.seq) || 0;
        // The snapshot is the server's document, which does not have our unacknowledged edits yet (one made
        // before the join landed, or during a dropped connection): they are sent again below, and put back
        // on the fresh document here, or this browser alone would go on showing the sheet without them.
        if (!same) for (const op of (E.pendingOps as Map<string, PendingOp>).values()) { if (op.docId === state.docId) applyChanges(op.changes); }
        replayPending(sock);
      }
    }
    if (msg.type === "op") { if (noteSeq(msg.seq, sock) !== "apply") return; E.editsSeen++; if (E.kdoc) { applyRemoteChanges(msg.changes); reapplyPending(msg.changes); } else noteRemoteOp(msg); bumpEditsSoon(); if (!E.kdoc) scheduleRenderRefresh(); }
    if (msg.type === "ops") {
      for (const op of msg.ops || []) {
        const step = noteSeq(op.seq, sock);
        if (step === "gap") break;                     // a resync is on its way; the rest is moot
        if (step === "skip") continue;                 // already applied
        E.editsSeen++; if (E.kdoc) { applyRemoteChanges(op.changes); reapplyPending(op.changes); } else noteRemoteOp(op);
      }
      bumpEditsSoon(); if (!E.kdoc) scheduleRenderRefresh();
    }
    if (msg.type === "reset" && msg.docId === state.docId) requestResync(sock, true);
  };
}

/**
 * The op stream is sequential per doc, so a hole means we missed something.  The desktop skips
 * duplicates and asks for a fresh base on the first gap; the web used to ignore `seq` entirely
 * and would keep applying ops on top of a document that had silently diverged.  Returns false
 * when the caller should not apply this op.
 */
export function noteSeq(seq: unknown, sock?: WebSocket) {
  const n = Number(seq);
  if (!n) return "apply";                            // no sequence on the wire: nothing to check
  if (E.lastSeq && n <= E.lastSeq) return "skip";     // already applied (a replayed op re-acked)
  if (E.lastSeq && n > E.lastSeq + 1) { if (sock) requestResync(sock); return "gap"; }
  E.lastSeq = n;
  return "apply";
}

export function requestResync(sock?: WebSocket | null, force?: boolean) {
  const ws = sock || E.ws;
  if (!ws || ws.readyState !== 1 || !state.docId) return;
  if (!force && Date.now() - E.resyncAt < 3000) return;   // one request per burst, not one per dropped op
  E.resyncAt = Date.now();
  ws.send(JSON.stringify({ type: "resync", docId: state.docId }));
}

/**
 * A refusal that names a clientOpId is about that one op: drop it from the journal (so it is not
 * replayed forever) and ask for a fresh base, which is what puts the local document back.  A
 * refusal with no clientOpId is about the *join* — that is the one that means "view-only".
 */
export function onOpRejected(sock: WebSocket, msg: ServerError) {
  if (msg.clientOpId) {
    E.pendingOps.delete(msg.clientOpId);
    if (msg.code === "permission_denied" && typeof msg.role === "string") { setRole(msg.role); setConn("live", liveLabel()); renderProps(); }
    toast(msg.code === "permission_denied" ? (E.canComment ? "That edit was not saved: you can comment here, but not edit" : "That edit was not saved: you have view-only access") : "The server refused an edit; reloading it");
    requestResync(sock);
    return;
  }
  if (msg.code === "not_joined") {           // an op beat our join on this socket: re-join, doc_info replays what is pending
    E.joinedDocId = null;
    sock.send(JSON.stringify({ type: "join_doc", docId: msg.docId || state.docId }));
    return;
  }
  if (msg.code !== "permission_denied") { toast("The server could not open this document here"); setConn("err", "join refused"); return; }
  // A join refused outright: access is gone (removed, link turned off, project made private).
  E.viewOnly = true; E.canComment = false; store.set({ viewOnly: true, canComment: false });
  E.drag = null; dragG.replaceChildren(); setConn("err", "no access"); renderProps(); toast("You no longer have access to this project", 5000);
}

/**
 * Ops we sent (or made while offline) that the server has not acknowledged.  The desktop keeps
 * the same journal on disk and replays it on every reconnect; without one, a socket that drops
 * between the local apply and the ack loses the edit outright — the reconnect snapshot replaces
 * the whole document and the change is simply gone, with the UI still claiming it was kept.
 * The server dedups on (docId, clientId, clientOpId), so replaying an op it already has is a
 * no-op re-ack rather than a second copy.
 */
export function replayPending(sock?: WebSocket | null) {
  const ws = sock || E.ws;
  if (!ws || ws.readyState !== 1) return;
  for (const [clientOpId, op] of E.pendingOps as Map<string, PendingOp>) {
    if (op.docId !== state.docId) continue;   // kept: switching back to that sheet replays it
    ws.send(JSON.stringify({ type: "op", docId: op.docId, clientOpId, baseSeq: null, changes: op.changes }));
  }
}

/**
 * Keep the local document in server order.  An op of ours that is still unacknowledged was applied here
 * first, but the server sequences it *after* every op we receive before its ack — so a remote change to
 * an item one of those ops also touches must not be the last word locally: our change is put back on top.
 * (Changes are whole-item replacements, so re-applying one is idempotent.)  Without this, two people
 * editing the same item at the same moment each ended up showing the other's version.
 */
export function reapplyPending(remote: KChange[] | null | undefined) {
  if (!E.pendingOps.size || !remote || !remote.length) return;
  const touched = new Set<string>(); let docLevel = false;
  for (const c of remote) { if (c && c.id) touched.add(String(c.id)); else docLevel = true; }
  for (const op of (E.pendingOps as Map<string, PendingOp>).values()) {
    if (op.docId !== state.docId) continue;
    const again = (op.changes || []).filter((c) => (c && c.id ? touched.has(String(c.id)) : docLevel));
    if (again.length) applyChanges(again);
  }
}

/** The edit counter after somebody else's edits: once for all that arrive within a tenth of a second, not once each. */
let editsTimer = 0;
function bumpEditsSoon() { if (!editsTimer) editsTimer = window.setTimeout(() => { editsTimer = 0; bumpEdits(); }, 100); }

export function bumpEdits() { store.slice("connection", { edits: E.editsSeen }); noteEdit(); }

export function noteRemoteOp(msg: { changes?: KChange[] }) {
  for (const c of msg.changes || []) {
    if (c.typeName !== E.ITEM_TYPE) continue;
    if (c.kind === "REMOVED") { E.items = E.items.filter((f: ItemSummary) => f.id !== c.id); E.selection.delete(c.id); if (E.selected && E.selected.id === c.id) { E.selected = null; renderProps(); } continue; }
    const fp: ItemSummary | undefined = E.items.find((f: ItemSummary) => f.id === c.id);
    if (!fp || c.kind !== "MODIFIED") continue;
    for (const p of c.properties || []) {
      if (p.name === "Position X" && p.after) fp.x = p.after.v as number;
      if (p.name === "Position Y" && p.after) fp.y = p.after.v as number;
      if (p.name === "Orientation" && p.after) fp.rot = p.after.v as number;
    }
    if (E.selected && E.selected.id === fp.id) renderProps();
  }
  drawSelection(); renderObjects();
}

/**
 * @param changes   the wire-format changes
 * @param transient true for the previews streamed while a drag is in flight — the drop sends the
 *                  authoritative change, so these must not pile up in the journal or be replayed.
 */
export function sendOp(changes: KChange[], transient?: boolean) {
  if (historyActive()) { if (!transient) toast("This is an earlier version. Leave the timeline to edit."); return; }
  if (state.docId && (state.docId.startsWith("board:") || state.docId.startsWith("lib:"))) { E.editsSeen++; bumpEdits(); return; }   // a board footprint's private copy (editor/fpedit.ts)
  const clientOpId = `web:${++E.opN}`;
  // Journal first, send second.  Anything still here when the socket comes back is replayed,
  // so an edit made during a blip (or before the join lands) survives instead of being wiped
  // by the reconnect snapshot.
  if (!transient) { E.pendingOps.set(clientOpId, { docId: state.docId, changes }); updateTitle(); }
  if (E.ws && E.ws.readyState === 1 && E.joinedDocId === state.docId) {
    E.ws.send(JSON.stringify({ type: "op", docId: state.docId, clientOpId, baseSeq: null, changes }));
  } else if (!transient && (!E.ws || E.ws.readyState !== 1)) {
    toast("Not connected — the change is kept and sent when the connection is back");
  }
  E.editsSeen++; bumpEdits(); if (!E.kdoc) scheduleRenderRefresh();
}
