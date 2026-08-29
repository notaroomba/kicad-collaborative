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

- [ ] Join a project you already have open under a *different* directory name —
  does doc matching fail gracefully?
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
- [ ] Viewer-role client: every edit path rejected cleanly, no error spam.
  (Web client: done — a viewer's drag gets `permission_denied` and the page
  shows a "view-only" chip and stops offering drags.  Desktop client still to
  verify.)
- [x] Optional wire fields must tolerate being absent, not just null — the
  protocol crate now marks them `#[serde(default)]` and pins a minimal
  browser hello in a test (a bare `{{type,proto,token,clientId}}` hello was
  rejected as `bad_message`).
- [x] clientId stays stable across reconnects: clients echo back the
  server-assigned `uid:` prefixed id, and the server now strips its own
  repeated prefix instead of growing one per reconnect (op dedup and presence
  identity depend on it).
- [ ] Rotating JWT_SECRET (or restarting with an unset one) sends connected
  editors `auth_failed`, which permanently disconnects them by design — but
  the editor shows no banner explaining why.  Surface a "session signed out —
  rejoin" notice instead of a silent disconnect.
- [ ] Share dialog: invite → revoke → re-invite; pending → sign-in → granted.
- [ ] Checkpoint → restore while a peer is live (reset banner UX).
- [ ] Online Projects: open the same cloud project twice; second open reuses the
  local copy without re-downloading.
- [ ] Presence keepalive across a laptop sleep/wake (reconnect + rejoin).
