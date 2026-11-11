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
| GET | `/` · `/gallery` · `/trash` · `/p/{id}` · `/p/{id}/edit` | the web app: projects, Explore, Trash, the editor (one React page serves them all) |
| GET | `/api/gallery` | public projects (no auth) |
| GET | `/api/projects/{id}/preview.svg` | cached kicad-cli SVG render (needs `KICAD_CLI`) |
| GET | `/j/{token}` | share-link landing page; visiting changes nothing, "Open in the web editor" claims the link (`POST /api/join/{token}`) and opens the project |
| GET | `/auth/github/login`, `/auth/github/callback` | web sign-in |
| POST | `/auth/logout` | web sign-out (clears the session cookie) |
| GET/POST | `/auth/desktop/{authorize,confirm,token}` | KiCad sign-in |
| GET | `/api/me` | current user |
| GET | `/api/users/search?q=` | share-dialog typeahead: server accounts + GitHub user search |
| GET/POST | `/api/projects` | list my projects (owned + member, with description, member count, owner avatar, `starred`) · upload a project (multipart: a zip as `archive`, or loose `file` parts named by project-relative path; non-KiCad files are skipped and reported, a wrapping folder is stripped) |
| GET/PATCH/DELETE | `/api/projects/{id}` | project info · rename / describe / make public (owner) · move to the Trash (owner; `?permanent=true` destroys it at once, the Trash is purged after 30 days) |
| POST | `/api/projects/blank` | create an empty project (`name`): a `.kicad_pro`, a root schematic and a board, as KiCad's File → New Project writes them |
| GET | `/api/trash` | the caller's trashed projects, with `deletedAt` and `purgeAt` |
| POST | `/api/projects/{id}/undelete` | take a project back out of the Trash (owner) |
| PUT/DELETE | `/api/projects/{id}/star` | star · unstar a project for the caller only |
| POST | `/api/projects/{id}/transfer` | hand the project to a member (`userId`); the old owner stays as an editor |
| POST | `/api/join/{token}` | claim a share link: the caller becomes a member with the link's role (a role the owner set by hand is kept) |
| POST | `/api/projects/{id}/clone` | copy a visible project into the caller's account |
| POST | `/api/projects/{id}/leave` | a member gives up their own access |
| GET | `/api/projects/{id}/archive` | download zip |
| GET/POST | `/api/projects/{id}/links` | list the share links that still work (owner) · create one (`role`, optional `expiresInDays`) |
| POST | `/api/projects/{id}/invites` | invite by login/email (instant grant when the account exists, else pending) |
| PATCH/DELETE | `/api/projects/{id}/invites/{inviteId}` | change the role a pending invite grants · revoke it |
| GET | `/api/projects/{id}/members` | who has access: owner, members, `canManage`; any member may read it, pending invites are owner-only |
| PATCH/DELETE | `/api/projects/{id}/members/{userId}` | change a member's role · revoke access (owner); both reach sessions that are already connected |
| POST/GET | `/api/projects/{id}/checkpoints` | name · list version checkpoints |
| POST | `/api/projects/{id}/restore` | restore a checkpoint (hard reset + resync) |
| POST | `/api/docs/{id}/snapshots?seq=N` | upload a snapshot |
| GET | `/api/docs/{id}/snapshots/{seq}` | fetch a historical file |
| DELETE | `/api/links/{token}` | revoke a share link |
| GET | `/ws` | the sync WebSocket |

## Vendor parts and part libraries

Parts can be found at LCSC / JLCPCB, Mouser and DigiKey and placed straight
into a schematic or a board (`src/parts/`, dialog in `web/parts/`, in the
editor under Tools → Add Part from Vendor… and Part Libraries…).

A saved library stores **references only**: vendor, vendor part number,
manufacturer part number and manufacturer. Everything else is fetched when the
part is used and kept in a shared cache (`parts`, `part_models`), so a library
still works when a vendor is unreachable. The cache holds the vendor's own data
(listing, EasyEDA drawing, STEP model); the KiCad symbol and footprint are
converted from it on each request (`src/parts/easyeda.rs`). A placed part is
embedded in the sheet or board as KiCad does, with `LCSC` / `Mouser` /
`DigiKey`, `MPN` and `Manufacturer` fields.

LCSC needs no key. Mouser and DigiKey need API keys, either for the whole
deployment (`MOUSER_API_KEY`, `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET`) or
per person in the dialog's API Keys tab (stored encrypted in `vendor_keys`).
Neither publishes drawings, so their parts use the LCSC drawing for the same
manufacturer part number when there is one.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/parts/vendors` | vendors and whether each is usable |
| PUT/DELETE | `/api/parts/keys/{vendor}` | save (after a test search) · remove your key |
| GET | `/api/parts/search?q=&vendor=` | search one vendor or all |
| GET | `/api/parts/part?vendor=&id=&lib=&refresh=` | listing, symbol, footprint |
| PUT | `/api/parts/cad` | use another LCSC part's drawings for a part |
| GET | `/api/parts/model.step?vendor=&id=` | 3D model |
| GET/POST | `/api/libraries` | list · create |
| GET/PATCH/DELETE | `/api/libraries/{id}` | parts · rename, share with a project · delete |
| POST | `/api/libraries/{id}/items` | add a part |
| PATCH/DELETE | `/api/libraries/{id}/items/{item}` | note · remove |
| POST | `/api/libraries/{id}/refresh` | refetch every part |
| GET | `/api/libraries/{id}/export.zip` | `.kicad_sym`, `.pretty`, `.3dshapes` for desktop KiCad |

## GitHub repository sync

An online project can be linked to one folder of one branch of a GitHub
repository (`src/github.rs`, page at `/github` and `/p/{id}/github`, also under
File → GitHub Sync… in the web editor).

- **Connecting.** Sign-in asks GitHub for identity only. Repository access is a
  separate grant (`/auth/github/connect`, same OAuth app and callback, `repo`
  or `public_repo` scope) that a user gives when they want sync and can drop
  again. The token is stored AES-GCM encrypted under a key derived from
  `JWT_SECRET`; every GitHub call is made as the user doing the action.
- **Comparing.** The server remembers the git blob id each file had the last
  time both sides agreed. That tells a file changed online (push) from one
  changed on GitHub (pull) from one changed on both.
- **Push** commits the files that changed online on top of the branch head —
  never forced, and files GitHub changed are left alone. It can instead go to a
  new branch with a pull request. A missing branch is created from the default
  branch; an empty repository gets its first commit.
- **Pull** brings GitHub's changes in. A file changed on both sides is merged
  item by item (`src/merge.rs`): items are matched by their `uuid`, each side's
  changes are kept, and only an item both sides changed differently needs a
  side picked (the page says which items, and which side was kept). The result
  is assembled from exact byte spans of the two files — nothing is
  re-serialised. What a pull replaces is kept as a named checkpoint.
- **Live sessions.** A project's file is its latest snapshot. Before reading
  it, a connected desktop client is asked to save; a pull will not replace a
  document that still has unsaved edits unless told to.

| Endpoint | |
|---|---|
| `GET/DELETE /api/github` | connection state / forget the token |
| `GET /api/github/repos`, `GET /api/github/scan?repo=&branch=` | repositories; KiCad project folders in one |
| `POST /api/github/import` | create a project from a repository folder, linked |
| `GET/PUT/DELETE /api/projects/{id}/github` | sync state / link (owner) / unlink (owner) |
| `GET /api/projects/{id}/github/diff?path=` | what each side changed in one file, item by item |
| `POST /api/projects/{id}/github/push`, `…/pull` | editors |

`GITHUB_API_URL` / `GITHUB_WEB_URL` point the server at another GitHub
(Enterprise, or the test stand-in).

## Design assistant

The web editor's Assistant pane (menu bar button, or View > Panels) is a chat
with Claude that can read the open design and propose edits to it.

- The browser runs the conversation and the design tools (components, nets,
  ERC/DRC, board statistics, selection, raw items) against the live document, so
  the model always sees what is on screen, unsaved edits included.
- The server is an authenticated proxy to the Anthropic Messages API. It owns
  the API key, the system prompt (`web/ai/system.md`) and the tool list
  (`web/ai/tools.json`); the browser sends only the messages. Web search and web
  fetch run on Anthropic's side and are how datasheets get read.
- The assistant never edits the design. `propose_changes` puts a card in the
  pane with a canvas preview; **Accept** sends the edits through the normal op
  pipeline as one undo step, so everyone in the session sees them and they are
  checkpointed like any other edit. A proposal whose items changed since it was
  made is refused.

| Endpoint | |
|---|---|
| `GET /api/ai` | whether the assistant is available to the caller, the model, today's usage |
| `PUT/DELETE /api/ai/key` | store / remove the caller's own API key (AES-GCM encrypted at rest) |
| `POST /api/projects/{id}/ai/chat` | `{messages}` in, the Messages API event stream out; project members only |

| Variable | |
|---|---|
| `ANTHROPIC_API_KEY` | the server's key. Without it the assistant works only for people who add their own key in its settings |
| `AI_MODEL`, `AI_EFFORT` | model id and effort level (defaults: the current Opus model, `medium`) |
| `AI_DAILY_REQUESTS` | model calls per person per day on the server's key (default 300) |
| `AI_WEB_TOOLS=0` | turn off web search and fetch |
| `ANTHROPIC_API_URL` | another endpoint (a gateway, or the test stand-in) |

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

`server/scripts/github-e2e.mjs` (API) and `github-ui.mjs` (the page, in
Chromium, desktop and phone sizes) test repository sync against
`fake-github.mjs`, an in-memory stand-in for GitHub's OAuth and git database
API, so no real repository is touched. `KICAD_FILES_DIR=.. cargo test --
--ignored real_files` runs the merge over every KiCad file in the source tree.

`server/scripts/ai-ui.mjs` drives the assistant in Chromium against
`fake-anthropic.mjs`, a scripted stand-in for the Messages API: streaming, every
design tool on a schematic and a board, proposal preview / accept / reject /
stale, a second client seeing an accepted edit, undo, errors, own keys, access.
`server/scripts/parts-e2e.mjs` (API) and `parts-ui.mjs` (two people in
Chromium) test vendor parts against `fake-vendors.mjs`, which replays answers
recorded from LCSC, JLCPCB and EasyEDA (`tests/fixtures/vendor/`, refreshed
with `capture-vendor-fixtures.sh`) and stands in for Mouser and DigiKey from
their API documentation.

`server/scripts/e2e.mjs` goes further: it drives two WebSocket clients through
the real join → op → ack → broadcast flow and checks sharing, role enforcement,
presence, idempotent resubmission and version history. It creates and deletes
test users, so point it at a **local server and a throwaway database only** —
usage is in the file header.
