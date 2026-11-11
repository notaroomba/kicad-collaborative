# KiCad Collaborative

Real-time multiplayer editing for KiCad — shared cursors, live selections, and
concurrent schematic **and board** editing, with cloud projects, offline support
and version history.

This is a fork of KiCad with collaboration built into the editors themselves
(the stock IPC API has no push channel and plugins cannot draw on the canvas, so
this could not be an add-on).

## Using it

**Cloud projects (the home for shared work).** There are two doors to the same
list of projects:

- **On the web:** open the server's address in a browser. The home page lists
  every project you own or were invited to, with search, sorting, stars and
  thumbnails. **New project** uploads a KiCad project folder, its files or a
  .zip (drag it onto the page), or starts a blank one. Each project's menu has
  Share, Rename, Edit details, Make a copy, Download .zip and Move to Trash;
  **Select** acts on several at once. It works on a phone too.
- **In the desktop app:** **File → Online Projects…** in the project manager.
  Sign in with GitHub, then browse, filter and sort the same list, open a
  project (it downloads a local copy into your projects folder and remembers the
  pairing), publish the project you have open, or manage it from the context
  menu.

A project opened either way rejoins its live session automatically every time
you open it — like a Figma file, the document's home is the server.

**Deleting is undoable.** Delete moves a project to the **Trash**: it closes for
everyone at once, and the owner can restore it, with its history, comments and
sharing, for 30 days. After that it is removed for good.

**Share a project.** From a project's menu on the web home, from the Online
Projects dialog (**Share…**), or in either editor: **File → Start Collaboration
Session…**. Sharing offers:

- a **share link** (editor or viewer role) copied to your clipboard, and
- **direct invites** by GitHub username or email, with typeahead search — like
  adding a collaborator on GitHub. People who already have an account get access
  instantly; everyone else gets a pending grant that attaches when they first
  sign in.

The same dialog lists who has access. The owner can switch anyone between
**can edit** and **can view**, remove them, turn a link off, list the project
publicly in Explore, or hand the project to another member (**Make owner…**).
Role changes and removals take effect at once, also for people who have the
project open. Collaborators can see the list but not change it, and can
**leave** a project from its menu.

**Join a project.** Paste a link into **File → Join Shared Project…** (either
editor) or **Online Projects… → Join from Link…** in the project manager, which
also offers to download a local copy.

**Leave.** **File → Leave Session**.

Everyone in a session sees each other's cursors (named and colour-coded) and
selections in both the schematic and board editors, and edits in both editors
sync live.

## What syncs

| | Status |
|---|---|
| Cursors (named, colour-coded), selections, viewports | Both editors, with a 10 s keepalive so idle peers stay visible |
| In-progress work: routes being pushed, wires being drawn | Live ghost segments in the peer's colour |
| In-progress drags | The real item is rendered at the peer's live position (when you have a copy), not just a box |
| Schematic item edits (move, rename, properties, add, delete) | Live |
| Wires, junctions, and other connectivity side-effects | Live, atomically with the edit that caused them |
| Board edits: tracks, vias, footprints, text, shapes, dimensions | Live |
| Zones | Live (outline; each client refills fills locally) |
| Ratsnest / connectivity after remote board edits | Rebuilt automatically |
| Undo / redo | Live — your undo broadcasts the restored state |
| Symbols & footprints from libraries you don't have | Arrive embedded; a project-local library copy is saved automatically (see below) |
| Project-local libraries, 3D models, tables in cloud projects | Travel with the project archive, types auto-detected |
| Board groups & tuning-pattern generators | Removal only; add/edit is next |
| Sheet add/remove/reparent, schematic group membership | Not yet — save and re-share |

## Libraries

Placed symbols and footprints always travel **fully embedded** in the sync ops, so a
collaborator never needs your libraries to see your edits. On top of that:

- When an item arrives whose library nickname doesn't resolve locally, the client
  saves a project-local copy — footprints into
  `<project>/collab-libs/<nickname>.pretty/`, symbols into
  `<project>/collab-libs/<nickname>.kicad_sym` — and adds a matching row to the
  project library table, so the reference resolves on your machine too.
  Controlled by `collab.save_missing_libraries` (default on) and
  `collab.local_library_dir` (default `collab-libs`) in kicad_common.json.
- Cloud project archives include project-local libraries (`.kicad_sym`,
  `.pretty`/`.kicad_mod`), 3D models (`.step`/`.wrl`), design rules, worksheets and
  library tables; file types are auto-detected from their names on both ends. So
  uploading a project uploads its libraries, and everyone who opens it from
  **Online Projects…** gets them.

## How it works

Same model Figma uses, not a CRDT.

- A server holds the authoritative document. Every edit becomes a small JSON
  *op* describing which properties of which item changed, keyed by KiCad's own
  item UUIDs.
- The server stamps each op with a sequence number, stores it durably, then
  broadcasts it. Clients apply ops in sequence order, so **conflicts resolve
  per property**: if you move a symbol while someone renames it, both survive.
  Only edits to the *same property* race, and the last one to reach the server
  wins.
- Presence (cursors and selections) travels on a separate channel that is never
  stored, coalesced to 20 updates/second.
- Deletes are immediate with no tombstones; undoing a delete re-sends the item.

Ops reuse KiCad's own diff/merge machinery (`common/diff_merge/`), so the wire
format is the same typed property-delta representation the built-in file diff
already produces.  Board items travel the same way; their s-expression payloads
are wrapped in a versioned `kicad_pcb` document (the clipboard trick), nets are
re-resolved **by name** on the receiving board, footprint pad nets ride along as
a pad→net map, and zone fills are stripped from the wire — each client refills
locally.

## Offline

Edits made while disconnected are journalled beside the project in
`<project>.collab/oplog.ndjson` (`oplog-board.ndjson` for the board editor). On
reconnect the client catches up on what it missed, then replays its own
unacknowledged ops. Duplicate submissions are ignored by the server, so a
replay after a crash is safe.

The `<project>.collab/link.json` file written when you upload, join or download
a project records which server project the local copy belongs to; it is what
makes the editors rejoin the session automatically on open.

If you were away long enough that the server no longer has the ops you missed,
it sends a fresh snapshot instead.

## Version history

Any editor can name a checkpoint; the owner can restore one, which resets the
document for everyone. Automatic snapshots are taken as the op log grows, and
old ops are pruned once a snapshot covers them. Named checkpoints are kept
forever.

## Access control

- Sign-in is GitHub only. There are no passwords.
- Share links grant **editor** or **viewer** and can be revoked or given an
  expiry.
- People can also be invited by GitHub username or email from the Share dialog
  (with typeahead search over server accounts, topped up from GitHub's user
  search when the server has GitHub credentials). Invitees with an account get
  access immediately; an email or unknown-username invite becomes a pending
  grant that attaches when they first sign in.
- Revoking a link does not remove people who already used it — the owner removes
  members (and pending invites) from the Share dialog's *People with Access*
  list.
- Viewers can see and follow, but their edits are rejected by the server.

## Running your own server

The sync server is a single Rust binary plus Postgres — see
[`server/README.md`](server/README.md). Point KiCad at it with:

```bash
export KICAD_COLLAB_SERVER=https://your-server.example.com
```

## Limitations

- **One server instance.** Documents are authoritative in memory, so the server
  does not scale horizontally without sharding first.
- **Same project on both sides.** Live editing requires everyone to have a copy
  of the project open. Opening from **Online Projects…** (or *Join from Link*'s
  download offer) provides that copy; a locally modified copy can still drift
  until the stale-file resync flow lands.
- **Simultaneous edits to one text field** clobber rather than merge, as in
  Figma. Per-character text merging is not implemented.
- **Undo is per-user.** Undoing restores the whole item, which can overwrite a
  collaborator's newer change to that item — the result is broadcast, so
  everyone stays consistent, but it can surprise.
- **Remote zone edits arrive unfilled** until you refill (B), unless auto-refill
  is enabled.
- **Publishing blocks the window.** The Online Projects and Share dialogs talk
  to the server in the background, but publishing the open project still
  freezes the window until the upload returns; fine on a healthy network,
  unpleasant when the server is unreachable.
- **macOS needs a WebSocket-capable libcurl** (Homebrew's, not Apple's system
  one). The client now tells you instead of silently retrying forever.

## Testing hooks

- `KICAD_COLLAB_SERVER` — point the client at a different server.
- `KICAD_COLLAB_TOKEN` — bearer token override (bypasses keychain + browser
  sign-in), so two instances on one machine can act as different users.
- `KICAD_API_SOCKET_PATH` — per-instance IPC API socket, so both instances can
  be driven programmatically.
- `KICAD_LOG_TO_STDERR` — route wxLog to stderr instead of modal dialogs.
- QA: `qa_eeschema --run_test="CollabSync*"`, `qa_pcbnew --run_test="PcbCollabSync*"`,
  `cargo test` + `server/scripts/e2e.mjs` for the server.
