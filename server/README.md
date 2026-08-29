# kicad-collab-server

Sync server for KiCad Collaborative — real-time multiplayer editing for KiCad.

One Rust binary (axum + tokio + sqlx) plus Postgres. Live at
`https://kicad-collab-production.up.railway.app`.

## Model

Server-authoritative, Figma-style — **not** a CRDT:

- One in-memory **document actor** per open document, serializing all writes.
- Each op gets the next per-doc sequence number and is **durably inserted before
  it is acked or broadcast**, so anything a client ever saw survives a crash.
- Conflict resolution is **property-level last-writer-wins**, applied *by clients*
  in sequence order. The server never inspects or transforms change contents —
  it validates structure, membership and role, nothing more.
- **No tombstones**: deletes are immediate; undo data lives in the deleting
  client, which re-sends the object to undo a delete.
- **Presence** (cursors, selections, viewports) is a separate ephemeral channel:
  never persisted, coalesced to 20 Hz, evicted after 30 s of silence.
- **Snapshots are client-produced.** Editors upload canonical s-expression files
  they already serialize; the server stores bytes and never parses KiCad formats.

## Wire protocol (v1, JSON over one WebSocket at `/ws`)

Client → server: `hello` · `join_doc` · `leave_doc` · `op` · `presence` · `resync`
Server → client: `hello_ok` · `doc_info` · `ops` · `snapshot` · `op` · `ack` ·
`presence` · `peer_joined` · `peer_left` · `snapshot_request` · `reset` · `error`

Ops carry KiCad's own diff/merge JSON (`ITEM_CHANGE`: `id`, `typeName`, `kind` ∈
{ADDED, REMOVED, MODIFIED}, `properties[]`), plus an `sexpr` payload on ADDED.

Apply rules (client side, in seq order): MODIFIED sets each named property
unconditionally; ADDED with an existing UUID is an upsert-replace; REMOVED or
MODIFIED for an unknown UUID is a no-op (delete beats a concurrent modify).

## Auth

The server brokers GitHub OAuth so no client secret ships in KiCad.

- **Desktop**: KiCad opens `/auth/desktop/authorize` (PKCE S256, loopback
  redirect) → GitHub → a consent page → `/auth/desktop/confirm` → the one-time
  code reaches the loopback → `POST /auth/desktop/token` → 30-day HS256 JWT,
  stored in the OS keychain.
- **Web**: standard GitHub flow, JWT in an HttpOnly SameSite=Lax cookie.
- Email invites become pending grants, matched against verified GitHub emails at
  first sign-in. There are no password accounts.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | liveness + DB check |
| GET | `/gallery` · `/p/{id}` · `/p/{id}/live` | public gallery, project page, live board viewer (web) |
| GET | `/api/gallery` | public projects (no auth) |
| GET | `/api/projects/{id}/preview.svg` | cached kicad-cli SVG render (needs `KICAD_CLI`) |
| GET | `/j/{token}` | share-link landing page |
| GET | `/auth/github/login`, `/auth/github/callback` | web sign-in |
| GET/POST | `/auth/desktop/{authorize,confirm,token}` | KiCad sign-in |
| GET | `/api/me` | current user |
| GET | `/api/users/search?q=` | share-dialog typeahead: server accounts + GitHub user search |
| GET/POST | `/api/projects` | list my projects (owned + member) · upload a project (zip, multipart) |
| GET/PATCH/DELETE | `/api/projects/{id}` | project info · rename · delete (owner) |
| GET | `/api/projects/{id}/archive` | download zip |
| POST | `/api/projects/{id}/links` | share link |
| POST | `/api/projects/{id}/invites` | invite by login/email (instant grant when the account exists, else pending) |
| DELETE | `/api/projects/{id}/invites/{inviteId}` | revoke a pending invite |
| GET/DELETE | `/api/projects/{id}/members[/{userId}]` | list members + pending · revoke access |
| POST/GET | `/api/projects/{id}/checkpoints` | name · list version checkpoints |
| POST | `/api/projects/{id}/restore` | restore a checkpoint (hard reset + resync) |
| POST | `/api/docs/{id}/snapshots?seq=N` | upload a snapshot |
| GET | `/api/docs/{id}/snapshots/{seq}` | fetch a historical file |
| DELETE | `/api/links/{token}` | revoke a share link |
| GET | `/ws` | the sync WebSocket |

## Running

```bash
DATABASE_URL=postgres://... JWT_SECRET=... PUBLIC_URL=http://localhost:8080 \
  GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
  KICAD_CLI=/usr/bin/kicad-cli RENDER_CACHE_DIR=./render-cache cargo run
```

Migrations run on boot. Without GitHub credentials the server still starts and
serves, but sign-in returns 503.

## Deploying

```bash
railway up --service kicad-collab
```

**Single replica only** — the doc actors are authoritative in memory. Scaling out
requires sharding documents across instances first.

## Tests

```bash
cargo test
```

Covers the wire-format validator, the zip path/type guards, the zip-bomb decode
bound, and the presence size cap.

Against a running deployment, the unauthenticated protocol surface (HTTP status
codes, share-link page, OAuth state-cookie binding, WebSocket handshake
rejections) can be smoke-tested with:

```bash
node server/scripts/smoke.mjs
```

`server/scripts/e2e.mjs` goes further: it drives two WebSocket clients through
the real join → op → ack → broadcast flow and checks sharing, role enforcement,
presence, idempotent resubmission and version history. It creates and deletes
test users, so point it at a **local server and a throwaway database only** —
usage is in the file header.
