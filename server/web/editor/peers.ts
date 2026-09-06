// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { state, store } from "./appstore";
import { E } from "./state";
import { toast } from "./util";
import { applyView, mmH, mmW, mmX0, mmY0, stage, visibleRectNm, world } from "./view";
export function cycleFollow() {
  const ids = Object.keys(E.peerState);
  if (!ids.length) { toast("No one else is here to follow"); return; }
  const i = ids.indexOf(E.followPeer);
  E.followPeer = ids[(i + 1) % ids.length] || null;
  const p = E.peerState[E.followPeer];
  toast(`Following ${peerName(p)} — zoom or pan to stop`);
  applyFollowWeb(E.peerState); renderPeers();
}

export function peerName(p) { return (p && p.user && (p.user.name || p.user.login)) || "peer"; }


// ---- follow ----
export function applyFollowWeb(peers) {
  if (!E.followPeer) return;
  const entry = peers[E.followPeer];
  if (!entry) { E.followPeer = null; toast("Stopped following (they left)"); renderPeers(); return; }
  const vp = (entry.state || {}).viewport;
  if (!vp || vp.length < 4 || vp[2] <= 0) return;
  const w = world.clientWidth || stage.clientWidth;
  const xMm = vp[0] / E.IU, yMm = vp[1] / E.IU, wMm = vp[2] / E.IU;
  E.zoom = Math.min(40, Math.max(0.2, (stage.clientWidth / w) * (mmW() / wMm)));
  E.panX = -((xMm - mmX0()) / mmW()) * w * E.zoom;
  E.panY = -((yMm - mmY0()) / mmH()) * (w * mmH() / mmW()) * E.zoom;
  E.suppressBreakout = true; applyView(); E.suppressBreakout = false;
}

export function breakFollow() {
  if (!E.followPeer || E.suppressBreakout) return;
  E.followPeer = null; toast("Stopped following"); renderPeers();
}

export function renderPeers() {
  store.set({ peers: { list: Object.keys(E.peerState).map((cid) => { const p = E.peerState[cid]; return { cid, name: peerName(p), color: (p.user && p.user.color) || "#4477ee" }; }), follow: E.followPeer } });
}

export function followAction(cid) { E.followPeer = cid && E.peerState[cid] ? cid : null; applyFollowWeb(E.peerState); renderPeers(); }

export function sendPresence(mmPos, ghostSegs) {
  const now = Date.now();
  if (!E.ws || E.ws.readyState !== 1 || (now - E.lastPresence < 80 && !ghostSegs)) return;
  E.lastPresence = now;
  const st = { cursor: [Math.round(mmPos[0] * E.IU), Math.round(mmPos[1] * E.IU)] };
  const vp = visibleRectNm(); if (vp) st.viewport = vp;
  if (ghostSegs) st.ghost = ghostSegs;
  E.ws.send(JSON.stringify({ type: "presence", docId: state.docId, state: st }));
}
