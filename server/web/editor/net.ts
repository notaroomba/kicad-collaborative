// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { state, store } from "./appstore";
import { noteCommentMsg } from "./comments";
import { applyChanges, renderObjects, setDocFromText } from "./doc";
import { applyFollowWeb, renderPeers } from "./peers";
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
  sock.onopen = () => { if (E.ws !== sock) return; E.myClientId = "web-" + Math.random().toString(36).slice(2, 10);
    sock.send(JSON.stringify({ type: "hello", proto: 1, token: E.wsToken, clientId: E.myClientId, linkToken: null, client: "web" })); };
  sock.onclose = (ev) => {
    clearTimeout(watchdog);
    console.warn(`collab socket closed: code=${ev.code} clean=${ev.wasClean} reason=${JSON.stringify(ev.reason || "")}`);
    if (E.ws !== sock || gen !== E.connectGen) return;   // superseded: not ours to reconnect
    E.ws = null;
    peersG.replaceChildren(); E.peerState = {}; renderPeers();
    const delay = Math.min(15000, 1000 * Math.pow(2, E.retries++));
    setConn("err", `reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => { if (state.view === "editor" && gen === E.connectGen) connect().catch(() => {}); }, delay);
  };
  sock.onmessage = (ev) => {
    if (E.ws !== sock) return;
    const msg = JSON.parse(ev.data);
    if (msg.type === "error") console.warn("collab server error:", msg.code, msg.docId || "");
    if (msg.type === "hello_ok") { handshakeDone = true; clearTimeout(watchdog); E.retries = 0; sock.send(JSON.stringify({ type: "join_doc", docId: state.docId })); }
    if (msg.type === "error" && (msg.code === "bad_message" || msg.code === "unsupported_protocol")) { setConn("err", `server refused the session (${msg.code}) — reload`); }
    if (msg.type === "error" && msg.code === "auth_failed") {
      sock.onclose = null; sock.close(); if (E.ws === sock) E.ws = null;
      setConn("err", "sign-in expired — reload to reconnect");
    }
    if (msg.type === "doc_info") { E.peerState = {}; setConn("live", E.viewOnly ? "live · view-only" : "live"); renderPeers(); }
    if (msg.type === "presence") { for (const [cid, e] of Object.entries(msg.peers || {})) { if (cid === E.myClientId || cid.endsWith(":" + E.myClientId)) continue; if (e === null) delete E.peerState[cid]; else E.peerState[cid] = e; }
      drawPeers(E.peerState); applyFollowWeb(E.peerState); renderPeers(); }
    if (msg.type === "peer_left" && msg.clientId) { delete E.peerState[msg.clientId]; drawPeers(E.peerState); applyFollowWeb(E.peerState); renderPeers(); }
    if (msg.type === "error" && msg.code === "permission_denied") { setViewOnly(true); E.drag = null; dragG.replaceChildren(); setConn("live", "live · view-only"); renderProps(); toast("You have view-only access here"); }
    if (msg.type === "error" && msg.code === "desynced") { sock.send(JSON.stringify({ type: "resync", docId: state.docId })); }
    if (msg.type === "comment") noteCommentMsg(msg);
    if (msg.type === "snapshot" && msg.docId === state.docId && typeof msg.file === "string") {
      if (setDocFromText(msg.file)) for (const op of msg.thenOps || []) applyChanges(op.changes);
    }
    if (msg.type === "op") { E.editsSeen++; if (E.kdoc) applyChanges(msg.changes); else noteRemoteOp(msg); bumpEdits(); if (!E.kdoc) scheduleRenderRefresh(); }
    if (msg.type === "ops") { E.editsSeen += (msg.ops || []).length; if (E.kdoc) for (const op of msg.ops || []) applyChanges(op.changes); bumpEdits(); if (!E.kdoc) scheduleRenderRefresh(); }
    if (msg.type === "reset" && msg.docId === state.docId) { sock.send(JSON.stringify({ type: "resync", docId: state.docId })); }
  };
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

export function sendOp(changes) {
  if (!E.ws || E.ws.readyState !== 1) { toast("Not connected"); return; }
  E.ws.send(JSON.stringify({ type: "op", docId: state.docId, clientOpId: `web:${++E.opN}`, baseSeq: null, changes }));
  E.editsSeen++; bumpEdits(); if (!E.kdoc) scheduleRenderRefresh();
}
