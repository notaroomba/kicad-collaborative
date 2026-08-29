# Web plan — cloud pages, gallery, and the path to a browser viewer

The question that shapes everything: **how much of the existing codebase can the
web reuse?** There are two codebases with very different reuse economics:

| Codebase | Language | What it owns | Web reuse story |
|---|---|---|---|
| Editors (this fork) | C++ / wx / GAL | Document model, s-expression parsing, rendering, interaction | Compiling pcbnew/eeschema cores to WASM is a mega-project (wx and GAL don't port; the document model drags in half of `common/`). Not the MVP path. |
| Sync server | Rust | Wire protocol, auth, storage, presence | **Compiles to WASM trivially.** The protocol types can move into a shared crate used by the server *and* a browser client. |

So the web client is written in **Rust** (the user's "write the website in C or
something" instinct, with a toolchain that actually targets browsers): a shared
`protocol` crate gives the web the exact same op/presence/join types the server
validates, and the server itself renders the HTML shell. Where the browser needs
KiCad's *rendering*, we don't reimplement it — the server shells out to
`kicad-cli` (the same code the desktop uses) to render snapshots to SVG, and the
browser overlays live presence on top. Rendering reuse through the CLI, protocol
reuse through the crate, zero duplicated document model.

## Architecture in one paragraph

The server stays the single source of truth. Web pages are server-rendered
(axum handlers, like the existing `/j/{token}` page). Live behavior comes from
the *same* WebSocket the editors use — a viewer joins a doc exactly like KiCad
does, receives presence and ops, and draws cursors/selections/ghosts over an
SVG snapshot. Editing from the browser is deliberately out of scope until the
viewer is solid; when it comes, it starts with the op types that don't need
KiCad's geometry engine (moves, deletes, property edits — the property-delta
format is plain JSON).

## Milestones (the loop works through these)

- [x] **W1 — Public projects + gallery.** `projects.public` flag (private by
  default, owner opt-in via `PATCH /api/projects/{id}`), `GET /api/gallery`,
  a `/gallery` page, and a `/p/{id}` project page.
- [x] **W2 — SVG previews.** `GET /api/projects/{id}/preview.svg`: latest board
  (or schematic) snapshot rendered via `kicad-cli` on the server, cached by
  `(doc, seq)` on disk. Enabled when `KICAD_CLI` is set (the Docker image needs
  the kicad-cli layer; documented in server/README).
- [x] **W3 — Live viewer v0.** `/p/{id}/live`: the preview SVG with a JS overlay
  that joins the doc over WS (viewer token from the session cookie), draws named
  cursors/selections/ghost segments, and shows an "edits happening — refresh"
  chip when ops arrive. (JS first; port to the shared-crate WASM module when the
  overlay grows real logic.)
- [x] **W4 — Protocol crate.** `server/protocol` (`kicad-collab-protocol`):
  ClientMsg/ServerMsg/ItemChangeWire serde types, consumed by the server's
  WebSocket handler, unit-tested against the documented wire shapes, and
  verified to compile standalone for `wasm32-unknown-unknown`.
- [x] **W5 — Gallery polish.** Project descriptions (`projects.description`,
  PATCH-able by the owner, inline edit form on the project page), gallery
  cards with blurb / owner / updated-at (newest-edit ordering), preview
  freshness (doc actors now request a snapshot whenever any ops are
  un-snapshotted — every 5 min, `SNAPSHOT_FRESH_SECS` overrides for tests —
  instead of only past a 500-op lag, so previews and clones track the live
  document), and `POST /api/projects/{id}/clone`: a private copy of every doc
  at its latest snapshot, with a "Clone to my account" button on the project
  page.  Verified e2e: description edit round-trips through the real form;
  a fresh snapshot landed automatically (seq 0 → 42) and re-rendered the
  preview; bob's clone contains all 5 docs at the fresh snapshot.  Found in
  passing: the new-generator snapshot format positions footprints with
  `(transform (translate …))` while older files use `(at …)` — the
  board-items scraper now handles both.
- [x] **W6 — Web editing spike.** Move a footprint from the browser: the live
  page now hit-tests against `GET /api/projects/{id}/board-items` (footprint
  uuid + position scraped from the latest board snapshot), lets an editor-role
  viewer drag one, and sends a MODIFIED op whose property deltas ("Position X"
  / "Position Y", `{type:"int", v:<nm>}`) match `PROPERTY_DELTA::FromJson` —
  nothing from the C++ model needed, the op is pure JSON.  Verified e2e: a real
  pointer drag in the browser moved D4 to the identical nanometre position on
  both live desktop editors; a viewer-role drag got `permission_denied` and the
  page flipped to a "view-only" chip with no error spam.  The page also sends
  cursor presence now, auto-reconnects with backoff (rejoining the doc), and
  folds peers' position deltas back into its hit-test index.

## Standing e2e polish checklist (every loop iteration picks at least one)

The class of paper-cuts found while testing (invisible name text, evicted idle
cursors, empty in-progress boxes, stale-lock dialogs, missing-library refs):

- [x] Join a project you already have open under a *different* directory name.
  Doc matching keys on project-relative paths, so the directory (and its
  parents) can be named anything — the standing three-instance fleet lives in
  three differently-named directories and syncs.  A *renamed project file*
  (different relative path) simply doesn't match any server doc: edits to
  that screen stay local, no crash — graceful, though silent; a "this file
  is not part of the shared project" notice would be a nice touch someday.
- [x] Kill an editor mid-session; relaunch; no stale `.lck` dialog blocks
  startup.  (Lock files now record the owning pid; a same-user lock whose
  process is dead is reclaimed silently even when other KiCad instances are
  running — the old "no other instance" heuristic was too conservative for
  multi-instance collaboration.)
- [x] Two people edit the same footprint's position simultaneously — LWW result
  identical on both sides.  (Was broken: an older concurrent remote op clobbered
  the newer local edit on one side only.  Fixed by re-asserting own newer
  in-flight/recent changes after applying a remote op — valid because acks and
  broadcasts share one in-order stream, so anything unacked is provably newer.)
- [x] Viewer-role client: every edit path rejected cleanly, no error spam.
  Web client: a viewer's drag gets `permission_denied` and the page shows a
  "view-only" chip and stops offering drags.  Desktop client: `OnOpRejected`
  now drops the op from the unacked set *and* the journal (it used to replay
  forever), shows one throttled "view-only access" infobar per burst, and
  requests a resync; the board engine then restores the touched items from
  the server's snapshot through the normal remote-apply path (upsert, or
  removal for an item the server never accepted), so the optimistic local
  edit visibly rolls back.  Verified e2e with a third live instance on a
  viewer token: the edit was refused, the other editors never saw it, the
  viewer's board rolled back to the server position, and the journal ended
  clean.  Schematic engine now has the same item-level snapshot
  rollback (LoadContent-parsed temp screen, per-item re-format with
  lib-symbol embedding, applied through the normal remote path) — QA-covered
  by the green CollabSync suites; live-driving a schematic viewer edit
  headlessly isn't possible yet (the IPC API is board-only), so its live
  verification rides on the identical, live-verified board architecture.
- [x] Optional wire fields must tolerate being absent, not just null — the
  protocol crate now marks them `#[serde(default)]` and pins a minimal
  browser hello in a test (a bare `{{type,proto,token,clientId}}` hello was
  rejected as `bad_message`).
- [x] clientId stays stable across reconnects: clients echo back the
  server-assigned `uid:` prefixed id, and the server now strips its own
  repeated prefix instead of growing one per reconnect (op dedup and presence
  identity depend on it).
- [x] Rotating JWT_SECRET (or restarting with an unset one) sends connected
  editors `auth_failed`, which permanently disconnects them by design.  The
  session now records the disconnect reason and both editors show a
  "sign-in expired or was revoked — rejoin from File > Online Projects"
  infobar instead of silently sitting at "offline".
- [x] Share dialog: invite → revoke → re-invite; verified through the API the
  dialog drives: member revoke, instant re-grant for existing accounts, the
  never-downgrade rule (re-inviting an editor as viewer keeps editor), email
  invite → pending listed → pending revoke.  (The last leg — pending →
  sign-in → granted — needs a real GitHub OAuth round-trip and stays manual.)
- [x] Checkpoint → restore while a peer is live.  Verified with three live
  editors: restore lands as a fresh snapshot at head+1, the reset reaches
  every client with no crash or disconnect, sync continues cleanly at the
  next seq, and the editors keep working Editors now RECONCILE
  automatically on reset instead of asking the user to rejoin: the engine
  pulls the restored file, diffs every top-level item against the open
  document (net numbers normalized — identity travels by name), and applies
  upserts/removals through the normal remote path, with an informational
  "synchronizing…" / "synchronized" infobar pair.  Verified live with three
  editors: a post-checkpoint move AND a newly added track were both undone
  automatically on every instance, all three boards ended geometrically
  identical (same sorted-track hash), and the reconcile even healed ~14
  tracks of historic drift the old no-hot-load resyncs had left behind.
  Schematic engine has the same reconcile (screen-level, ERC markers
  excluded), QA-covered.  Found and fixed a real corruption in passing: a
  client freshness snapshot upload racing in at the same seq *overwrote the
  named checkpoint row* (the upsert clobbered it), so a later restore
  restored post-checkpoint content.  Client snapshot uploads are now
  insert-only — a snapshot at a given seq, once written, is immutable —
  and the full cycle re-verified with the race present: the named row
  survived and restore produced genuine checkpoint content.
- [x] Online Projects: open the same cloud project twice; second open reuses
  the local copy without re-downloading.  A per-user registry
  (`collab-local-copies.json` in the settings dir) remembers where each cloud
  project's copy lives; re-opening now skips both the directory prompt and
  the download and goes straight to the recorded `.kicad_pro`.  Reuse is
  refused when the file is gone or the directory's `link.json` no longer
  matches the project (moved or repurposed copy) — all covered by the new
  `CollabProjectRegistry` QA suite (round-trip, gone/repurposed, corrupt
  registry recovery).
- [x] Presence keepalive across a laptop sleep/wake (reconnect + rejoin).
  Simulated with SIGSTOP/SIGCONT on a live editor: frozen 50 s (past the 30 s
  presence eviction) while a peer edited, the woken instance caught up on the
  missed op within seconds, and its own next edit propagated to every peer.
- [x] Blocking REST on the UI thread (from the report's "Still open" list):
  the session now owns a worker thread (`COLLAB_SESSION::RunAsync`, joined in
  Shutdown before curl cleanup).  Snapshot uploads — which fire every few
  minutes per editor since the freshness change — serialize on the UI thread
  but upload in the background; the Online Projects listing shows a
  "Loading..." row and fetches off-thread (destroy-safe via a liveness
  guard); the share-dialog typeahead searches off-thread with a generation
  counter so stale results never paint over newer ones.  Verified live: a
  freshness snapshot landed through the worker path, and a clean app quit
  joins the worker without hanging.  (Remaining sync REST: project
  download/upload and the invite actions — one-shot user-initiated
  operations behind explicit buttons.)
