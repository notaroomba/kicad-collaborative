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
- [ ] **W5 — Gallery polish.** Project descriptions, owner attribution,
  updated-at, preview freshness (re-render when snapshot seq advances), and a
  "clone to my account" button (server-side copy).
- [ ] **W6 — Web editing spike.** From the WASM protocol crate: select + move a
  footprint from the browser (property-delta MODIFIED op), applied live by
  desktop peers. Requires nothing from the C++ model — the op is pure JSON.

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
- [ ] Share dialog: invite → revoke → re-invite; pending → sign-in → granted.
- [ ] Checkpoint → restore while a peer is live (reset banner UX).
- [ ] Online Projects: open the same cloud project twice; second open reuses the
  local copy without re-downloading.
- [ ] Presence keepalive across a laptop sleep/wake (reconnect + rejoin).
