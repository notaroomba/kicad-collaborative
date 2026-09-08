// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { state, store } from "./appstore";
import { noteCommentMsg } from "./comments";
import { applyChanges, renderObjects, setDocFromText } from "./doc";
import { applyFollowWeb, renderPeers, startPresenceKeepalive } from "./peers";
import { drawSelection, renderProps } from "./selection";
import { E } from "./state";
import { api, toast } from "./util";
import { dragG, drawPeers, peersG, scheduleRenderRefresh } from "./view";
// ---- websocket / presence / ops ----
export function setConn(cls, text) { store.slice("connection", { status: cls === "live" ? "live" : cls === "err" ? "error" : "offline", text: text || (cls === "live" ? "live" : "offline") }); }

export function setViewOnly(v) { E.viewOnly = !!v; store.set({ viewOnly: E.viewOnly }); }

   // bumped by every connect()/leaveDoc(); a stale socket's events are ignored
export async function connect() {
  const gen = ++E.connectGen;
  if (!state.me) { setConn("", "sign in to collaborate"); return; }
  setConn("err", E.retries ? `reconnecting…` : "connecting…");
  // A cookie riding the WS upgrade is unreliable (SameSite / tracking
  // protection / proxies), so authenticate the socket with a token fetched
  // over a normal request and sent in the hello frame, like the desktop.
  let ticket;
  try {
    ticket = (await api("/api/ws-ticket")).token || "";
  } catch (e) {
    if (gen === E.connectGen) setConn("err", "sign-in expired — reload to reconnect");
    return;   // a bad ticket would just loop; wait for a reload/re-auth
  }
  if (gen !== E.connectGen || state.view !== "editor") return;   // the document changed while we waited
  E.wsToken = ticket;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let sock;
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
      if (typeof msg.role === "string") setViewOnly(msg.role !== "editor");
      setConn("live", E.viewOnly ? "live · view-only" : "live"); renderPeers(); startPresenceKeepalive();
    }
    if (msg.type === "presence") { for (const [cid, e] of Object.entries(msg.peers || {})) { if (cid === E.myClientId || cid.endsWith(":" + E.myClientId)) continue; if (e === null) delete E.peerState[cid]; else E.peerState[cid] = e; }
      drawPeers(E.peerState); applyFollowWeb(E.peerState); renderPeers(); }
    if (msg.type === "peer_left" && msg.clientId) { delete E.peerState[msg.clientId]; drawPeers(E.peerState); applyFollowWeb(E.peerState); renderPeers(); }
    // Our own ops are acked, never broadcast back to us, so the ack is how their seq enters our
    // count — without it the next remote op would read as a gap and trigger a needless resync.
    if (msg.type === "ack" && msg.clientOpId) { E.pendingOps.delete(msg.clientOpId); E.lastSeq = Math.max(E.lastSeq, Number(msg.seq) || 0); }
    if (msg.type === "error" && (msg.code === "permission_denied" || msg.code === "bad_op" || msg.code === "internal" || msg.code === "not_found")) onOpRejected(sock, msg);
    if (msg.type === "error" && msg.code === "desynced") requestResync(sock, true);
    if (msg.type === "comment") noteCommentMsg(msg);
    if (msg.type === "snapshot" && msg.docId === state.docId && typeof msg.file === "string") {
      if (setDocFromText(msg.file)) {
        E.lastSeq = Number(msg.seq) || 0;
        for (const op of msg.thenOps || []) { applyChanges(op.changes); noteSeq(op.seq); }
        replayPending(sock);
      }
    }
    if (msg.type === "op") { if (noteSeq(msg.seq, sock) !== "apply") return; E.editsSeen++; if (E.kdoc) applyChanges(msg.changes); else noteRemoteOp(msg); bumpEdits(); if (!E.kdoc) scheduleRenderRefresh(); }
    if (msg.type === "ops") {
      for (const op of msg.ops || []) {
        const step = noteSeq(op.seq, sock);
        if (step === "gap") break;                     // a resync is on its way; the rest is moot
        if (step === "skip") continue;                 // already applied
        E.editsSeen++; if (E.kdoc) applyChanges(op.changes); else noteRemoteOp(op);
      }
      bumpEdits(); if (!E.kdoc) scheduleRenderRefresh();
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
export function noteSeq(seq, sock) {
  const n = Number(seq);
  if (!n) return "apply";                            // no sequence on the wire: nothing to check
  if (E.lastSeq && n <= E.lastSeq) return "skip";     // already applied (a replayed op re-acked)
  if (E.lastSeq && n > E.lastSeq + 1) { if (sock) requestResync(sock); return "gap"; }
  E.lastSeq = n;
  return "apply";
}

export function requestResync(sock, force) {
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
export function onOpRejected(sock, msg) {
  if (msg.clientOpId) {
    E.pendingOps.delete(msg.clientOpId);
    toast(msg.code === "permission_denied" ? "That edit was refused — you may no longer have edit access" : "The server refused an edit; reloading it");
    requestResync(sock);
    return;
  }
  if (msg.code === "not_joined") {           // an op beat our join on this socket: re-join, doc_info replays what is pending
    E.joinedDocId = null;
    sock.send(JSON.stringify({ type: "join_doc", docId: msg.docId || state.docId }));
    return;
  }
  if (msg.code !== "permission_denied") { toast("The server could not open this document here"); setConn("err", "join refused"); return; }
  setViewOnly(true); E.drag = null; dragG.replaceChildren(); setConn("live", "live · view-only"); renderProps(); toast("You have view-only access here");
}

/**
 * Ops we sent (or made while offline) that the server has not acknowledged.  The desktop keeps
 * the same journal on disk and replays it on every reconnect; without one, a socket that drops
 * between the local apply and the ack loses the edit outright — the reconnect snapshot replaces
 * the whole document and the change is simply gone, with the UI still claiming it was kept.
 * The server dedups on (docId, clientId, clientOpId), so replaying an op it already has is a
 * no-op re-ack rather than a second copy.
 */
export function replayPending(sock) {
  const ws = sock || E.ws;
  if (!ws || ws.readyState !== 1) return;
  for (const [clientOpId, op] of E.pendingOps) {
    if (op.docId !== state.docId) continue;   // kept: switching back to that sheet replays it
    ws.send(JSON.stringify({ type: "op", docId: op.docId, clientOpId, baseSeq: null, changes: op.changes }));
  }
}

export function bumpEdits() { store.slice("connection", { edits: E.editsSeen }); }

export function noteRemoteOp(msg) {
  for (const c of msg.changes || []) {
    if (c.typeName !== E.ITEM_TYPE) continue;
    if (c.kind === "REMOVED") { E.items = E.items.filter((f) => f.id !== c.id); E.selection.delete(c.id); if (E.selected && E.selected.id === c.id) { E.selected = null; renderProps(); } continue; }
    const fp = E.items.find((f) => f.id === c.id);
    if (!fp || c.kind !== "MODIFIED") continue;
    for (const p of c.properties || []) {
      if (p.name === "Position X" && p.after) fp.x = p.after.v;
      if (p.name === "Position Y" && p.after) fp.y = p.after.v;
      if (p.name === "Orientation" && p.after) fp.rot = p.after.v;
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
export function sendOp(changes, transient) {
  const clientOpId = `web:${++E.opN}`;
  // Journal first, send second.  Anything still here when the socket comes back is replayed,
  // so an edit made during a blip (or before the join lands) survives instead of being wiped
  // by the reconnect snapshot.
  if (!transient) E.pendingOps.set(clientOpId, { docId: state.docId, changes });
  if (E.ws && E.ws.readyState === 1 && E.joinedDocId === state.docId) {
    E.ws.send(JSON.stringify({ type: "op", docId: state.docId, clientOpId, baseSeq: null, changes }));
  } else if (!transient && (!E.ws || E.ws.readyState !== 1)) {
    toast("Not connected — the change is kept and sent when the connection is back");
  }
  E.editsSeen++; bumpEdits(); if (!E.kdoc) scheduleRenderRefresh();
}
