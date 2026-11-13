# Junction

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
| Zones | Live, outline and fill. A fill is computed once, by whoever refills, and everyone receives that exact copper. The browser draws fills and asks a desktop editor to refill (B) |
| Ratsnest / connectivity after remote board edits | Rebuilt automatically |
| Undo / redo | Live — your undo broadcasts the restored state |
| Symbols & footprints from libraries you don't have | Arrive embedded; a project-local library copy is saved automatically (see below) |
| Project-local libraries, 3D models, tables in cloud projects | Travel with the project archive, types auto-detected |
| Board groups & tuning-pattern generators | Live: create, edit, regroup, nest, remove |
| Schematic groups | Live, membership included, in both the desktop and browser editors |
| Hierarchical sheets: add, remove, move, a second instance of the same file | Live. A new sheet's contents follow as their own document; removing the sheet someone is looking at moves them to its parent |

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
re-resolved **by name** on the receiving board, and footprint pad nets ride along as
a pad→net map.  A zone travels with its fill, so every client shows the copper the
filler actually produced instead of refilling on its own and hoping the results
agree.  A refill is shared as an edit marked as a fill; an outline or setting change
from someone else marks the zone as needing a refill, exactly as a local edit does.
Large edits (a refill of a dense board) are split into several ops under the
server's message limit.

## Offline

A copy of an online project keeps working without a connection, on the desktop, and
merges when the connection returns.  Nothing has to be clicked.

**The connection drops while you work.**  The editor says so once and the status bar
shows `Collaboration: offline · N edits to send`.  Every edit is still captured, and
waits in a queue in the order it was made.  The WebSocket client keeps trying (1 s,
doubling to 30 s).  A link that goes quiet without closing (a sleeping laptop, a pulled
cable) is noticed too: the server pings every 20 s, and 45 s of silence counts as gone.

When it is back the editor rejoins from the last op it applied:

- If the server still has the ops it missed (it keeps them for at least a week), they
  are applied and the queue is sent on top, oldest first, 32 ops in flight at a time.
  Where a collaborator and you changed the same item, yours is the later edit and
  stands; where one side deleted it, it stays deleted.
- If not, the server sends a snapshot and the editor does a three-way merge per item
  instead: changed only online, take it; changed only here, publish it; changed on
  both sides, this copy wins unless either side deleted the item.  The base of that
  merge is the document as it stood when the connection dropped, so an edit you made
  *online* before the drop is not mistaken for an offline one.

Refilling zones repeatedly while offline queues only the last fill of each zone.

**You open the project with no connection at all.**  The editor starts the session
from what the server said about the project last time (`<project>.collab/project.json`:
the project id, its owner, and which document each file is), queues edits as above and
joins by itself as soon as the server can be reached.  A copy that has never been
opened online on this version has no such file yet: it shows the offline notice, asks
the server again every 30 s (or at once, with the notice's Reconnect link), and merges
what was done in the meantime when it answers.

**You close the editor while offline.**  What you saved is in the files, and the next
launch merges them: each sheet and the board are compared with their sync base
(`<project>.collab/base/…`, the file as it was when it last matched the server) and
with the online version, by the same three-way rule.  What you did not save is gone,
as in any KiCad session; it was never sent to anyone.  Nothing is replayed from a
journal on the next run (earlier versions did, in the wrong order and under a new
client id; a leftover `oplog*.ndjson` is deleted).

A hierarchical sheet added while offline gets its server document when the connection
returns, with whatever was drawn in it by then.

The `<project>.collab/link.json` file written when you upload, join or download
a project records which server project the local copy belongs to; it is what
makes the editors rejoin the session automatically on open.

## Version history

Any editor can name a checkpoint; the owner can restore one, which resets the
document for everyone. Automatic snapshots are taken as the op log grows, and
old ops are pruned once a snapshot covers them. Named checkpoints are kept
forever.

## Design review

Comment threads are pinned to a part or a net (or a place on the sheet) and
follow it as the design changes. The web editor's Compare window shows what
changed between any two versions of a schematic or board: now, a version, a
GitHub commit, or a file. See "Design review" in server/README.md.

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

<a id="limitations"></a>
## How it behaves

These are choices, not gaps.

- **Two people editing the same property at the same instant** end up with the
  later value, for a text field as for a coordinate. Different properties of the
  same item, and different items, never collide. This is the model Figma uses;
  design data is not prose, and a character-by-character merge of two net names
  is not a name anyone chose.
- **Undo is yours.** It restores your version of the items you changed, and that
  is broadcast like any edit, so everyone stays consistent. If a collaborator
  changed the same item after you, your undo wins over their change.
- **Zone fills come from the desktop application.** Its filler is what the
  fabrication output is made from, so the browser editor draws fills but never
  computes its own. *Fill All Zones* (B) in the browser asks a desktop editor in
  the document to refill, and says so when nobody has the board open there; the
  zones then keep their last fill until someone does.
- **A zone edited by someone else needs a refill**, as it would after your own
  edit. Whoever refills shares the result with everyone.
- **Any libcurl works.** Where the system libcurl has no WebSocket support
  (Apple's, Ubuntu's), the client speaks the protocol itself over a connection
  libcurl opens.

## Testing hooks

- `KICAD_COLLAB_SERVER` — point the client at a different server.
- `KICAD_COLLAB_TOKEN` — bearer token override (bypasses keychain + browser
  sign-in), so two instances on one machine can act as different users.
- `KICAD_API_SOCKET_PATH` — per-instance IPC API socket, so both instances can
  be driven programmatically.
- `KICAD_LOG_TO_STDERR` — route wxLog to stderr instead of modal dialogs.
- QA: `qa_eeschema --run_test="CollabSync*"`, `qa_pcbnew --run_test="PcbCollabSync*"`,
  `cargo test` + `server/scripts/e2e.mjs` for the server.
