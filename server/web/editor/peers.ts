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

/** The last cursor position we told anyone about, so the keepalive can re-send it. */
export function sendPresence(mmPos, ghostSegs) {
  const now = Date.now();
  if (mmPos) E.lastPresenceMm = mmPos;
  // A peer who has joined but not yet moved the pointer must still appear: fall back to the
  // centre of what they are looking at, which is also what the desktop's follow reads.
  const at = mmPos || E.lastPresenceMm || viewCentreMm();
  if (!at || !E.ws || E.ws.readyState !== 1 || !state.docId) return;
  // Ghost updates are rate-limited like the cursor; an *empty* ghost is the "I stopped drawing"
  // signal and must go out at once so peers do not keep painting a stale in-flight wire.
  const clearing = Array.isArray(ghostSegs) && ghostSegs.length === 0;
  if (now - E.lastPresence < 80 && !clearing) return;
  E.lastPresence = now;
  const st = { cursor: [Math.round(at[0] * E.IU), Math.round(at[1] * E.IU)] };
  const vp = visibleRectNm(); if (vp) st.viewport = vp;
  if (ghostSegs) st.ghost = ghostSegs;
  // What the peer has selected.  The desktop's rebuildOverlay draws a peer-coloured wash from
  // `boxes` (live geometry, so a drag in progress shows) and falls back to resolving `selection`
  // ids in its own copy; with neither the peer is a bare cursor and the desktop cannot tell that
  // the items moving under it belong to that person.  Same frame as the desktop sends:
  // BOX2I(origin, size) in internal units.
  // Everything this client has picked: the multi-selection, the single symbol / footprint (E.selected) and the
  // schematic module's own single pick (a wire, label, junction ...).
  const picked = new Set(E.selection || []);
  if (E.selected && E.selected.id) picked.add(E.selected.id);
  const schSel = E.DOC_TYPE === "kicad_sch" && window.CollabTools && window.CollabTools.sch && window.CollabTools.sch.state ? window.CollabTools.sch.state.sel : null;
  if (typeof schSel === "string" && schSel) picked.add(schSel);
  if (E.kdoc && picked.size) {
    const sel = [], boxes = [], at = [], plain = [];
    for (const id of picked) {
      if (sel.length >= MAX_PRESENCE_ITEMS) break;
      const it = E.kdoc.items.get(id), b = it && it.bbox;
      if (!b) { plain.push(id); continue; }
      // rebuildOverlay pairs selection[i] with boxes[i] (and at[i]), so only items that contribute a box
      // go in both lists; anything without geometry falls back to the id-only form.
      sel.push(id);
      boxes.push([Math.round(b[0] * E.IU), Math.round(b[1] * E.IU), Math.round((b[2] - b[0]) * E.IU), Math.round((b[3] - b[1]) * E.IU)]);
      // The item's anchor (its GetPosition on the desktop): a receiver that holds the item ghosts it displaced by
      // `at − its own anchor`, which is exact, where a bounding-box difference never is (fonts, text layers).
      const a = anchorMm(it); at.push(a ? [Math.round(a[0] * E.IU), Math.round(a[1] * E.IU)] : null);
    }
    if (boxes.length) { st.selection = sel; st.boxes = boxes; st.at = at; }
    else if (plain.length) st.selection = plain;
  }
  // The desktop only draws a peer that says which sheet it is on: SCH_COLLAB_TOOL::rebuildOverlay
  // skips any peer whose state.sheetFile differs from the sheet it is showing, and an absent field
  // reads as "" and never matches.  It is the document's project-relative path, which is exactly
  // what the server's doc list carries.
  const doc = (state.docs || []).find((d) => d.docId === state.docId);
  if (doc && doc.path) st.sheetFile = doc.path;
  E.ws.send(JSON.stringify({ type: "presence", docId: state.docId, state: st }));
}

/** Where an item is placed by (mm): its (at) / transform for symbols, footprints, vias and texts, else its first point. */
export function anchorMm(it) {
  const n = it.node, K = KiCadCanvas;
  if (!n) return null;
  if (n[0] === "arc" || n[0] === "gr_arc") return null;   // the desktop anchors arcs on their centre (EDA_SHAPE::getPosition), which the file's three points do not carry
  if (K.kid(n, "at") || K.kid(n, "transform")) { const a = K.atOf(n); return a ? [a[0], a[1]] : null; }
  for (const key of ["start", "center"]) { const p = K.kid(n, key); if (p) return [K.num(p[1]), K.num(p[2])]; }
  const pts = K.ptsOf(n); if (pts.length) return pts[0];
  const poly = K.kid(n, "polyline"); if (poly) { const pp = K.ptsOf(poly); if (pp.length) return pp[0]; }
  return null;
}

/** ws.rs rejects a presence state over 8 KB outright, and the desktop caps its own lists too. */
export const MAX_PRESENCE_ITEMS = 60;

/**
 * The server drops a client's presence after 30 s of silence (doc_actor.rs PRESENCE_STALE) and
 * broadcasts a null entry for it, which blanks the cursor on the desktop and — because the web's
 * peer list *is* the presence map — removes the peer from the web's pane entirely.  The desktop
 * beats that by re-sending unchanged state every 10 s off its tool timer; without this the web
 * has no such heartbeat, so a web user who stops moving the mouse simply disappears.
 */
export function startPresenceKeepalive() {
  stopPresenceKeepalive();
  E.presenceTimer = setInterval(() => {
    if (!E.ws || E.ws.readyState !== 1) return;
    if (Date.now() - E.lastPresence < 10000) return;
    E.lastPresence = 0;   // the 80 ms rate limit must not swallow the heartbeat
    sendPresence(null);
  }, 5000);
}

function viewCentreMm() { const v = visibleRectNm(); return v ? [(v[0] + v[2] / 2) / E.IU, (v[1] + v[3] / 2) / E.IU] : null; }

export function stopPresenceKeepalive() { if (E.presenceTimer) { clearInterval(E.presenceTimer); E.presenceTimer = 0; } }
