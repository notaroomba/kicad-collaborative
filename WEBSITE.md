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
- [x] Board groups sync fully (they used to sync removal only).  Group
  changes travel as the group's own sexpr plus a `groupMembers` uuid list
  resolved against the receiving board (a lone fragment's member ids cannot
  resolve at parse time); groups apply after their members within a batch;
  missing members are skipped and re-asserted by the next replace (LWW).
  Covered by two new QA cases and verified live across three editors:
  create → both receivers grouped the same two tracks; remove → gone
  everywhere, members intact.  Found live and fixed: removing a group left
  members' back-pointers dangling at the freed group and `IsLocked()`
  crashed a receiver — the applier now releases members before deletion
  (QA asserts it).  Generators (tuning patterns) ride the same path but
  have no live verification yet.  Mixed-version note: an old client skips
  a group op it cannot apply while still advancing its sequence, so after
  an upgrade the missed group appears only after the next reconcile or
  fresh snapshot join.
- [x] **Comments layer (server + web).**  Pinned comment threads on documents,
  the Figma model: a root comment carries a board position (nm), replies
  thread under it, anyone who can comment may resolve/reopen.  REST under
  `/api/docs/{id}/comments` + `/api/comments/{id}` (migration 0005); every
  mutation broadcasts a `comment` message through the doc actor so open
  clients update live (the protocol crate pins the shape).  The live page
  grew numbered pins (muted when resolved), a click-to-place compose panel,
  and a thread popover with reply/resolve.  Verified e2e with real clicks:
  alice placed a comment; carol — a *viewer*, commenting is the viewer
  role's superpower — replied and resolved via REST with both broadcasts
  arriving live on an open page; anonymous read works on public projects,
  anonymous write is refused (403); the desktop editors received the
  unknown `comment` broadcasts and stayed connected (graceful by design —
  in-editor pins are the next step).
- [x] **Comment pins in the PCB editor.**  The desktop now participates in the
  comments layer: comments are fetched on session join (off the UI thread via
  the session worker) and kept live by the `comment` broadcasts; the canvas
  overlay draws a numbered bubble at each thread's anchor, muted once
  resolved, through the same depth-safe chip/text path as the peer name tags.
  Two real bugs found by running it: nlohmann's `value()` with a default
  still *throws* when the key holds `null` (roots carry `"parentId": null`)
  and took two editors down — replaced with a null-safe accessor; and the
  comment endpoints only accepted cookie auth, so the desktop's Bearer-token
  writes got 403 — a `MaybeAuthUser` extractor now accepts both (anonymous
  writes still refused).  Verified live: three editors each loaded the
  existing threads on join and reacted to added/updated/deleted broadcasts
  in real time.  Still ahead: click-a-pin thread UI in the editor (pins are
  render-only today) and eeschema pins.
- [x] **In-editor comment thread UI + eeschema pins.**  pcbnew grew a
  Comments dialog (File menu, `pcbnew.Collab.comments`): browse threads,
  read a thread's full history, reply, resolve/reopen, and post a new
  comment pinned at the crosshair position — all mutations off the UI
  thread via the session worker, with the dialog reloading live on
  `comment` broadcasts.  Verified live through the real tool action over
  IPC: the dialog opened over the running session, and a REST-posted reply
  landed in it via broadcast without a crash.  eeschema mirrors the pin
  layer per sheet (comments keyed by doc id, pins drawn only for the
  displayed sheet) — verified live: a schematic-doc comment loaded on join
  and a resolve broadcast reached the running editor.  Pin click-to-open
  in the canvas remains the polish item on top.
- [x] Generators (tuning patterns) round-trip through the group transfer —
  QA-covered (`GeneratorRoundTrips`): sexpr + membership apply, type
  preserved, removal releases the member cleanly.
- [x] Comments dialog: "Show on Board" centers the canvas on the selected
  thread's pin (FocusOnLocation).
- [x] **Deployed to production.**  https://kicad-collab-production.up.railway.app
  — Dockerfile build stages pinned to bookworm (the rust:1-slim base had moved
  to a newer glibc than the runtime image and the binary refused to start),
  migrations 0002–0005 applied on boot, real GitHub OAuth configured, and the
  desktop's built-in DEFAULT_SERVER already points there.  Smoke-tested:
  healthz/gallery 200 over TLS, wss handshake works, bad token gets a clean
  auth_failed.  Previews are off in production until the image grows a
  kicad-cli layer (the gallery degrades gracefully without them).
- [x] **Toolbar icons fixed.**  Dev-tree builds on macOS showed every icon as
  "?" because images.tar.gz only reaches the app bundles during the install
  step; a POST_BUILD hook now mirrors the archive into all three bundles
  (and the error line is gone from every launch log).
- [x] **History sidebar panel (both editors).**  A docked "History" pane
  (File > History toggles it; it auto-shows when a session starts) lists the
  project's named checkpoints newest-first with doc counts, and offers
  Checkpoint... / Restore / Refresh — all REST off the UI thread, restore
  confirmed with a warning dialog and healed everywhere by the automatic
  reconcile.  The session now publishes the project id so whichever editor
  joined second can still bind the panel.
- [x] **Production deploy verified end-to-end.**  A desktop instance uploaded
  StickHub to https://kicad-collab-production.up.railway.app (real project,
  27 docs), auto-rejoined over wss, made it public with a description, and
  answered snapshot-freshness requests by pushing client-rendered previews —
  the production gallery serves them with zero KiCad on the server.  Also
  set SNAPSHOT_FRESH_SECS=60 in prod.  Papercuts queued: the share-link
  message box on Start Session blocks the IPC reply (swap for an infobar);
  client-plotted previews come out monochrome despite SetColorSettings
  (theme plumbing needs another look).
- [x] **Copy Share Link** action in both editors (File menu, next to
  Start/Join): mints an editor invite link off-thread and puts the URL on
  the clipboard with an infobar confirmation — verified live via the real
  action (clipboard ended holding the /j/ link).  Leave Session tooltip now
  says explicitly that leaving only disconnects this computer.
- [x] Gallery/project pages emit preview images unconditionally (hidden
  client-side if missing) — they were gated on server-side KICAD_CLI, which
  production intentionally lacks.
- [x] **Preview colors + share-modal + compression (loop 17).**  The
  monochrome previews were a stale-binary artifact — plots now carry the
  editor's own color theme (verified: F.Cu #C83434 / B.Cu #4D7FC4 / silk
  #F2EDA1, live in the production gallery's SVG).  Start Session's blocking
  share-link message box became an infobar (the link is on the clipboard and
  File > Copy Share Link re-mints it).  The server gained gzip/brotli
  compression (previews 373 KB -> 87 KB; pages too) after chasing an
  11-second image load that turned out to be the embedded test browser's own
  throttled proxy — real clients fetch the compressed SVG in ~0.13 s from
  the production edge.  Production redeployed and verified.
- [x] **Pin click-to-open (pcbnew) + comments dialog in eeschema (loop 18).**
  Clicking empty canvas within a comment pin's grab radius opens the
  Comments dialog focused on that thread (the pins are overlay drawings the
  selection tool cannot see, so the cleared-selection event does the
  hit-test).  The comments dialog moved to common
  (`DIALOG_COLLAB_COMMENTS`) and eeschema now has the full thread UI too —
  File > Comments..., per displayed sheet, live-reloading on broadcasts,
  with post/resolve off the UI thread.  (eeschema's IPC API has no
  RunAction handler, so its dialog rides on the pcbnew-verified shared
  component + green QA; the pin click needs a human mouse — both are
  one-click user-verifiable.)  All three collab QA suites green.
- [x] **Sheet-file sync mid-session (loop 19).**  Hierarchical sheets now
  transfer: capture allows sheet add/replace/removal; the applier preserves
  the live screen across upserts (fragments parse screen-less) and gives a
  brand-new sheet an empty screen; the engine's ensureSheetDocs creates the
  server doc mid-session (`POST /api/projects/{id}/docs`, idempotent by
  path), authors upload the new sheet's content as snapshot 0, and both
  sides register + join the new doc — receivers mark it reconcile-pending
  so the join snapshot populates the empty screen through the proven
  reconcile.  QA covers the full round trip with the real wire format
  (add with fresh screen, screen-preserving replace, removal).  The wire
  e2e also proved doc discovery on rejoin (a restarting client picks up the
  mid-session doc from the project listing) — and cost half a day to a
  self-inflicted pair of gotchas: a hand-crafted sheet sexpr the parser
  silently rejects (the real formatter's output round-trips fine), and
  "dead" editors that were actually children killed by their launching
  shell's timeout (the documented nohup gotcha, forgotten twice).
- [x] Copy Share Link UX: instant "creating..." infobar on first click, the
  link cached per session for instant repeat copies, cache cleared on
  session end.  (First-mint can sit behind snapshot uploads on the worker
  for a few seconds — the reported "doesn't copy" was pasting before the
  mint landed, with no feedback; viewer-role windows correctly refuse with
  an error infobar.)
- [x] Sheet-sync live e2e (loop 20): the wire fragment for sheets is a BARE
  `(sheet ...)` (the earlier synthetic test wrapped it in a full document —
  that was the parse failure).  A QA-side env-gated dump
  (`KICAD_QA_DUMP_SHEET_SEXPR`) now produces genuine formatter output for
  wire harnesses; replaying it against the live editor materialized the
  sheet ("creating screen" / "screen attached") with the editor healthy.
- [x] **Online editor v1 (loop 21).**  The live page graduated from "editing
  spike" to a real editor: scroll-zoom toward the cursor + right-drag pan
  (world-transform container, so all overlay math survives), click-select
  with a ring + rotation readout, R rotates 90 deg (the "Orientation" double
  property), Del/Backspace deletes, and drags STREAM live position ops at
  150 ms so peers watch the part move instead of jump on release; the board
  render auto-refreshes from the pushed previews after edits.  Verified
  e2e: a drag produced 3+ ops with both desktops converging on the exact
  final position; rotate -90 -> 0 landed on both; delete removed D4
  everywhere and a checkpoint restore's automatic reconcile resurrected it
  at the checkpoint position on all three editors.
- [x] **Peers see drags properly now (reported).**  Receivers hide the
  stationary original while a peer's live-drag ghost replaces it (the part
  was visible twice — old position plus ghost), restore it the moment the
  ghost clears, and drive KiCad's own dynamic-connectivity ratsnest for the
  ghosted items so the airwires stretch on every screen just like on the
  mover's.  Exercised with a 20-tick synthetic drag stream against three
  live editors: hide -> ratsnest -> unhide cycled cleanly, no crashes.
  Next Figma-parity candidates from the deep dive: click-a-peer to follow
  their viewport, track-drag ghosts beyond the router, and live text edits.
- [x] **Follow a peer's viewport (loop 22).**  The Figma follow gesture in
  pcbnew: click a collaborator's cursor on canvas to follow their viewport
  (same hit-test family as comment pins), or use File > Follow Next Peer to
  cycle; any manual pan/zoom — or the peer leaving — breaks the follow with
  an infobar.  Verified live: a synthetic peer parked at a distinctive
  viewport, the cycle action reached it, and alice's own outgoing presence
  showed her viewport snapped to the target region (aspect-corrected).
  eeschema parity is queued.
