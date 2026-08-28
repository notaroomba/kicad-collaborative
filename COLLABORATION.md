# KiCad Collaborative

Real-time multiplayer editing for KiCad — shared cursors, live selections, and
concurrent schematic editing, with offline support and version history.

This is a fork of KiCad with collaboration built into the editors themselves
(the stock IPC API has no push channel and plugins cannot draw on the canvas, so
this could not be an add-on).

## Using it

**Share a project.** In the schematic editor: **File → Start Collaboration
Session…**. Your project is uploaded, a share link is copied to your clipboard,
and you are live. Send the link to whoever you want in.

**Join a project.** Open the link in a browser and click *Open in KiCad*, or use
**File → Join Shared Project…** and paste the link. You will be asked to sign in
with GitHub the first time; the token is stored in your OS keychain.

**Leave.** **File → Leave Session**.

Everyone in a session sees each other's cursors (named and colour-coded) and
selections in both the schematic and board editors. Schematic edits sync live.

## What syncs

| | Status |
|---|---|
| Cursors, selections, viewports | Both editors |
| Schematic item edits (move, rename, properties, add, delete) | Live |
| Wires, junctions, and other connectivity side-effects | Live, atomically with the edit that caused them |
| Undo / redo | Live — your undo broadcasts the restored state |
| Board (PCB) edits | Presence only for now; editing is the next milestone |
| Sheet add/remove/reparent, group membership | Not yet — save and re-share |
| Project settings, libraries | Snapshot at session start only |

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
already produces.

## Offline

Edits made while disconnected are journalled beside the project in
`<project>.collab/oplog.ndjson`. On reconnect the client catches up on what it
missed, then replays its own unacknowledged ops. Duplicate submissions are
ignored by the server, so a replay after a crash is safe.

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
- People can also be invited by GitHub username or email; an email invite
  becomes a pending grant that attaches when they first sign in with a GitHub
  account carrying that verified address.
- Revoking a link does not remove people who already used it — the project owner
  removes them explicitly (`DELETE /api/projects/{id}/members/{userId}`).
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
- **Same project on both sides.** Live cursors require everyone to have the
  project open; joining downloads it, but a locally modified copy can drift.
- **Simultaneous edits to one text field** clobber rather than merge, as in
  Figma. Per-character text merging is not implemented.
- **Undo is per-user.** Undoing restores the whole item, which can overwrite a
  collaborator's newer change to that item — the result is broadcast, so
  everyone stays consistent, but it can surprise.
