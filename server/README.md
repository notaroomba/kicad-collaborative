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

Parts can be found at LCSC / JLCPCB, Mouser, DigiKey and Farnell / Newark /
element14 and placed straight
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

The dialog's BOM tab lists the parts of the design (every sheet, or the board) by the vendor
fields they carry, with stock and the price break for the number of boards,
finds and assigns a vendor part to lines that have none, and downloads the BOM
in JLCPCB's assembly format or in full.

LCSC needs no key. Mouser, DigiKey and Farnell need API keys, either for the
whole deployment (`MOUSER_API_KEY`, `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET`,
`FARNELL_API_KEY` with `FARNELL_STORE`, default `uk.farnell.com`) or
per person in the dialog's API Keys tab (stored encrypted in `vendor_keys`).
None of them publishes drawings, so their parts use the LCSC drawing for the same
manufacturer part number when there is one.

`/p/{id}/edit?parts=search|libraries|bom` and `/?parts=libraries` open the
dialog from a link. The desktop editors' File → Vendor Parts… opens that link:
in a session a part placed in the browser arrives in the desktop app like any
collaborator's edit; without one it opens the library manager.

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
- **Push on checkpoint** (a checkbox on the sync page) pushes the same way
  every time a checkpoint is saved, as the person who saved it, with the
  checkpoint's name as the commit message. It never overwrites a change made
  on GitHub; the page shows what the last one did.
- Only the linked folder is read from GitHub, so a project in a corner of a
  very large repository syncs as fast as one in its own.
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
- Schematic proposals are checked for pins that would end up on a different
  net, and the card says so. On a board, an `autoroute` edit runs the board
  autorouter and proposes its tracks and vias like any other change.

- **A board from a description.** The assistant can take a design from a prompt
  to a routed board, each stage a proposal: it finds parts in KiCad's symbol and
  footprint libraries (`find_parts`, `get_library_part`, served and cached by
  this server from the KiCad library repositories) and at the parts vendors,
  draws the schematic one functional block at a time (`add_symbol`, `add_wire`,
  `add_label`, power symbols, no-connects), runs ERC, brings the parts to the
  board (`update_from_schematic`), places them (`auto_place`, or explicit
  positions), and routes in stages it orders itself (`autoroute` with a net
  order, per-net widths and layers), judging each stage from the engine's
  report of what was left unrouted and why.
  `scripts/ai-rp2040.mjs` runs that whole flow for an RP2040 dev board through
  the same tool calls, with the plan written out by hand so it needs no key.

| Endpoint | |
|---|---|
| `GET /api/ai` | whether the assistant is available to the caller, the model, today's usage |
| `PUT/DELETE /api/ai/key` | store / remove the caller's own API key (AES-GCM encrypted at rest) |
| `POST /api/projects/{id}/ai/chat` | `{messages}` in, the Messages API event stream out; project members only |
| `GET /api/kicad-lib/search?kind=symbol\|footprint&q=` | search KiCad's libraries by name (index built on first use, cached a day) |
| `GET /api/kicad-lib/list?kind=&lib=` | libraries, or the items of one |
| `GET /api/kicad-lib/item?kind=&lib=&name=` | one symbol (`.kicad_sym`) or footprint (`.kicad_mod`) |
| `GET /api/docs/{id}/ops?since=N` | the ops applied to a document after snapshot `N`, so another document of the project is read as it is now |

| Variable | |
|---|---|
| `ANTHROPIC_API_KEY` | the server's key. Without it the assistant works only for people who add their own key in its settings |
| `AI_MODEL`, `AI_EFFORT` | model id and effort level (defaults: the current Opus model, `medium`) |
| `AI_DAILY_REQUESTS` | model calls per person per day on the server's key (default 300) |
| `AI_WEB_TOOLS=0` | turn off web search and fetch |
| `ANTHROPIC_API_URL` | another endpoint (a gateway, or the test stand-in) |
| `KICAD_LIBS_URL`, `KICAD_LIBS_REF` | where KiCad's libraries are read from (default `https://gitlab.com`, `master`); `scripts/kicad-libs-mirror.mjs` is a caching mirror for machines whose outbound traffic goes through a proxy |

## MCP server (Claude and other MCP clients)

`/mcp` is a Model Context Protocol endpoint, so Claude (Claude Code, the desktop app, claude.ai) can work on a
person's online projects from outside the editor: list and open projects, read schematics and boards, look at
them as pictures, run the checks, find parts, and make changes that everyone in the project sees live.

Connecting (the same steps are on the site's **Connect Claude** page, `/connect`, with the address filled in):

- **Claude Code**: `claude mcp add --transport http kicad https://<site>/mcp`, then `/mcp` inside Claude Code,
  pick `kicad` and sign in.
- **claude.ai and the desktop app**: Settings, Connectors, Add custom connector, paste `https://<site>/mcp`.
- Anything else that speaks MCP over Streamable HTTP with OAuth works the same way. A script can skip OAuth and
  send the session token the desktop app uses as `Authorization: Bearer <token>`.

How it is built:

- **Transport**: Streamable HTTP, stateless (`POST /mcp`; no server-to-client stream, so `GET` is 405). A
  `tools/call` is answered as an event stream with keep-alives when the client accepts one, so a long autoroute
  does not time out behind a proxy.
- **Sign-in** (`src/oauth.rs`): the server is its own OAuth 2.1 authorization server, as the MCP specification
  asks: protected resource metadata (RFC 9728), server metadata (RFC 8414), dynamic client registration
  (RFC 7591, public clients), authorization code with PKCE S256, refresh tokens that rotate on every use (a
  reused one revokes the connection), revocation (RFC 7009). The person signs in with GitHub as usual and sees a
  consent page naming the app; **Let it make changes** can be unticked for a read-only connection. Tokens are
  opaque, stored only as SHA-256 hashes, access tokens last an hour. `/connect` lists a person's connected apps
  and disconnects them. Cookies are never accepted on `/mcp`.
- **Tools** (`src/mcp.rs`, `web/mcp/`): the design tools are the in-app assistant's own (`web/ai/tools.json`,
  `design.ts`, `proposals.ts`, `library.ts`), not a second implementation. They are written against the web
  editor's document model, so the server runs them in a **headless editor**: a Node process per signed-in
  person (`web/mcp/host.ts`, bundled to `static/dist/mcp-host.js` and embedded in the binary) that joins the
  document over the ordinary collaboration WebSocket as a peer named "Name (App)", keeps it in step with
  everyone's edits, and sends its own as ordinary ops. Nothing about a change made this way is special to the
  desktop app or the web editor.
- **The one deliberate difference from the assistant**: in the editor the assistant proposes and a person
  accepts a card. Over MCP the person's own Claude app already asks before a tool runs, so `apply_changes`
  applies at once (with `dry_run` to look first). Every call is recorded (`mcp_changes`) with what it takes to
  reverse it, so `undo_changes` and `redo_changes` take a whole call back or put it back; both are refused when
  somebody has edited the same items since, so nobody's newer work is overwritten.
- **Pictures**: `render_view` draws the sheet or board from the editor's own geometry as SVG with stroke-font
  text (`web/mcp/picture.ts`) and the server rasterises it (resvg), so the model can look at what it changed.

| Tool | |
|---|---|
| `list_projects`, `get_project`, `create_project` | find, open and start projects |
| `get_design_overview`, `list_components`, `get_component`, `list_nets`, `get_items`, `get_board_info`, `read_document` | read a design |
| `run_checks` | ERC on a sheet, DRC on the board |
| `render_view` | a PNG of a sheet, the board, an area or some components |
| `find_parts`, `get_library_part`, `find_datasheets` | KiCad libraries, vendor parts, datasheet links |
| `apply_changes` | every edit the assistant can make: symbols, wires, labels, fields, moves, `update_from_schematic`, `auto_place`, `set_rules`, `autoroute`, raw items |
| `undo_changes`, `redo_changes`, `list_changes` | the record of what was changed through MCP |
| `list_comments`, `add_comment`, `resolve_comment` | review comments pinned on the design |
| `list_checkpoints`, `create_checkpoint` | named versions |
| `get_design_guide` | the assistant's drawing, layout, routing and review standards, for the model to read |

Prompts `review_design`, `tidy_schematic` and `design_board` appear as slash commands in clients that show them.

| Variable | |
|---|---|
| `KC_NODE` | the `node` to run the headless editor with (default `node` on the PATH; Node 20 or newer). The Docker image includes it. Without Node the endpoint still answers, the project and change-list tools work, and the design tools say the editor is unavailable |
| `MCP_MAX_HOSTS` | how many people's headless editors may run at once (default 24; the least recently used is stopped; each exits by itself after 15 idle minutes) |

## Running

```bash
DATABASE_URL=postgres://... JWT_SECRET=... PUBLIC_URL=http://localhost:8080 \
  GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
  KICAD_CLI=/usr/bin/kicad-cli RENDER_CACHE_DIR=./render-cache cargo run
```

Migrations run on boot. Without GitHub credentials the server still starts and
serves, but sign-in returns 503.

## Deploying

The hosted site (kicad.notaroomba.dev) is the Railway service `kicad-collab` in the
project `kicad-collaborative`.  Its source is this repository, branch `master`, root
directory `/server`, so every push to master builds `server/Dockerfile` and deploys.
A one-off upload of a local tree still works:

```bash
railway up --service kicad-collab
```

**Replicas.** Run as many as you like behind the load balancer; they need the same
`DATABASE_URL` and `JWT_SECRET` and nothing else (no Redis, no sticky sessions).
Each replica keeps an actor per open document for its own sockets, and they stay
in step through Postgres:

- an op gets its number from the `ops` primary key `(doc_id, seq)`, and while more
  than one replica is alive they queue on a per-document advisory lock, so the
  sequence is gapless and nobody is starved;
- everything else (who is here, cursors, comments, restores, access changes,
  requests) crosses on `LISTEN/NOTIFY`; a payload too big for a notification is
  parked in `relay_overflow` and fetched by id;
- sign-in state lives in the `auth_pending` table, so a flow can start on one
  replica and finish on another;
- replicas heartbeat every 10 s; one that goes silent for 35 s has its people
  removed from the documents on the others.

A replica running alone skips the lock and the per-op access re-check.
`server/scripts/replicas-e2e.mjs` drives four clients through two replicas
(600 concurrent ops, presence, comments, restore, demotion, sign-in, a replica
being killed); `e2e.mjs` takes `E2E_BASE_B` to put its second user on another
replica.

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
`REAL_REPO=owner/throwaway server/scripts/github-real.sh` runs the same flows
against real github.com (push, pull, item merge, pull request, push on
checkpoint, import, new branch) on a repository you can throw away, with a
token from `gh auth token`. Its bridge refuses writes to any other repository.

`server/scripts/ai-ui.mjs` drives the assistant in Chromium against
`fake-anthropic.mjs`, a scripted stand-in for the Messages API: streaming, every
design tool on a schematic and a board, proposal preview / accept / reject /
stale, a second client seeing an accepted edit, undo, errors, own keys, access.
`server/scripts/mcp-e2e.mjs` is the MCP endpoint end to end against a running
server (with `node` on its PATH): discovery, client registration, the consent
page, PKCE, refresh rotation and revocation; the protocol; a design drawn,
placed, ruled and routed through the tools while a second collaboration client
checks that each edit arrives live and attributed; undo, redo and an undo
refused because someone edited the item since; comments, checkpoints, a
read-only connection and a view-only project; and, with `SHOTS=dir`, a browser
that has the sheet open while the edits come in.

`server/scripts/parts-e2e.mjs` (API) and `parts-ui.mjs` (two people in
Chromium) test vendor parts against `fake-vendors.mjs`, which replays answers
recorded from LCSC, JLCPCB and EasyEDA (`tests/fixtures/vendor/`, refreshed
with `capture-vendor-fixtures.sh`) and stands in for Mouser, DigiKey and Farnell from
their API documentation.

Against the real vendors (network, and keys for all but LCSC; a vendor without
a key is reported as skipped):

```bash
MOUSER_API_KEY=… DIGIKEY_CLIENT_ID=… DIGIKEY_CLIENT_SECRET=… FARNELL_API_KEY=… \
  cargo test -- --ignored --nocapture live_
```

`server/scripts/e2e.mjs` goes further: it drives two WebSocket clients through
the real join → op → ack → broadcast flow and checks sharing, role enforcement,
presence, idempotent resubmission and version history. It creates and deletes
test users, so point it at a **local server and a throwaway database only** —
usage is in the file header.

## Board autorouter

`web/router/` (bundled to `static/dist/autoroute.js`) is the web editor's **Route ▸ Autoroute…**. It only runs when
someone asks for it, never moves or removes what is on the board, and commits its tracks and vias as ordinary
edits: one undo step, sent to everyone in the session.

- **Search**: a line-probe router (Mikami–Tabuchi line search on eight directions and all copper layers), not a
  maze or A* search. Both ends shoot straight rays; each level adds one corner or via; where rays from the two
  ends meet there is a candidate route with the fewest corners, and a cost picks among the candidates.
- **Rules**: track width, clearance and via size come from each net's class; other nets' copper, unplated holes,
  the board edge and keep-out rule areas are obstacles. Every result is checked again with exact geometry before
  it is returned, and anything that would break a rule is dropped and reported as unrouted.
- **Heuristics**: grid aligned to the pads, shortest connections first, rip-up and retry, whole-board retries with
  the failed connections first, joining a net's own track mid-way, plated holes as free layer changes, short
  via drops into the net's copper zone.
- **Weights**: `web/router/weights.ts` holds the cost weights and the list of boards they were fitted on.
  `node scripts/router-train.mjs boards.json --write` refits them from hand-routed boards;
  `node scripts/router-bench.mjs board.kicad_pcb…` strips boards and routes them again as a benchmark.
- Tests: `node static/tests/autoroute.test.js`; two browsers in one board: `node scripts/autoroute-ui.mjs`.
- Other tools can call `PcbAutoRouter.autoroute(ctx, { nets, layers, allowVias, passes, timeMs })` (commits and
  resolves with a summary) or `PcbAutoRouter.route(K, PcbTools, doc, settings, opts)` (pure, returns item nodes).

### After the search: pours, vias, supply widths

Once every connection has been tried, a few passes work on the finished board (all checked with exact geometry):

- **Pours** (`stitch`): a copper pour is cut into pieces by the other nets' tracks. The router models the fill
  (zone clearance and minimum width), finds which pads and vias sit in a piece cut off from the main body, takes
  out routes that ended in a dead piece, and joins each cut-off group to the main body with a track of its own.
  A via may drop into the net's pour on a plane layer. `opts.stitch: false` turns it off.
- **Fewer vias** (`fewerVias`): a via costs twice what the fitted weights say, and each route that changes layer
  is laid again on the finished board without vias (then with fewer) where that does not send it a long way round.
- **Smaller vias where nothing else fits** (`smallVias`): a connection still open after repair is tried once more
  with the smallest via Board Setup's constraints permit (minimum via diameter and hole, keeping the annular
  ring), next to the narrowest track. This is what lets balls inside a grid array escape when the net class's via
  is wider than the ball pitch allows. Set `smallVias: false` to keep every via at its class size.
- **Supply widths** (`powerWidth`): GND, rails and `VBUS`-style nets without a class or plan width of their own are
  widened piece by piece wherever the clearances leave room, necked down at tight pads. `0` keeps the class width.
- Board Setup's minimum clearance and hole clearance are floors for every net.

### Differential pairs, impedance and length matching

- **Pairs** (`pairs`): nets named as a pair (`D+`/`D-`, `_P`/`_N`, `DP`/`DM`, `TXP`/`TXN`) whose connections start
  and end side by side are laid as one: a single wide route down the middle, split into two tracks a constant gap
  apart, each led straight off its pad and turned in to its partner. A pair stays on one layer and nothing tees
  into it. When the geometry does not allow it (a part right in front of the pads, pads on different layers) the
  two nets are routed singly and `result.pairs[]` says why.
- **Impedance** (`impedance`, `netOpts[net].impedance`): `web/router/impedance.ts` reads the board's physical
  stackup (or assumes the usual build for the layer count) and computes the track width, and for pairs the gap,
  that present the target: 90 Ω for USB pairs, 100 Ω for HDMI, Ethernet, LVDS and MIPI pairs, 50 Ω for nets named
  as antenna or RF feeds, or whatever a plan asks for. Microstrip (Hammerstad, Wheeler) on outer layers, IPC-2141
  stripline inside, IPC edge-coupling for pairs. A width the board cannot reasonably carry (50 Ω on a 1.6 mm
  two-layer board is 2.8 mm) is not applied; `result.impedance[]` gives the width that would be needed and why.
  The models are closed-form: within a few percent of a field solver, not a substitute for the fab's calculator.
- **Length matching** (`matchLengths`, `match: [{ nets, tolerance, length }]`, `skewTolerance`, `maxAmplitude`):
  the pairs of one bus (`HDMI_D0…D2` and the clock, `ETH_TX`/`ETH_RX`) and any group a plan names are brought to
  the longest member's length (or a given one) with serpentines on their longest straight runs: deep square humps
  first, more and shallower ones where there is less room, shallow 45° bumps for the last fraction. A pair's
  serpentine is put on its centre line so both tracks swing together; skew left inside a pair is taken out with
  a bump on the shorter track. `result.matched[]` lists each member before and after, and says when there was no
  room.
- `node scripts/hs-bench.mjs outDir` routes four small boards from nothing (HDMI lanes with ground pins between P
  and N, Ethernet pairs to through-hole pins, a Bluetooth antenna feed on four and on two layers) and prints
  completion, rule errors, pairs, widths and lengths.

### Planning and judging from outside (the assistant)

The engine does the geometry and keeps the rules; what to route first, on which layers and how wide can come from a
plan — the assistant's model, or a person. Everything here is pure (nothing is written to the board):

- `PcbAutoRouter.route(K, P, doc, settings, opts)` also takes `order` (net names routed first, in that order),
  `netOpts[net] = { layers, width, allowVias, maxVias, avoid: [[x0,y0,x1,y1]…], priority }` and
  `keepouts: [{ layers?, box }]` for the run. Its result lists every connection in `connections`: pads at both ends,
  length, vias, bends, layers, detour ratio, and for a failure the `reason` (`blocked` by nets routed earlier,
  `no-room` past what is on the board, dropped by a `rule` in the exact check, or out of `budget`) with `blockedBy`.
- `PcbAutoRouter.evaluate(K, P, doc, settings, { drc })` gives the numbers a layout is judged by: ratsnest length,
  unrouted connections, vias, track length, the nets that wander furthest, and per-net figures.
- `PcbAutoRouter.place(K, P, doc, settings, { footprints, outline, spacing })` places components the way a person
  does: each functional group (`group`, with `near` and `anchor` hints) is first laid out as a tight block around
  its anchor part, then the blocks are positioned and rotated inside the outline — fixed parts and parts on an
  `edge` first, the rest where their connections are shortest; nets that reach everywhere (ground, rails) do not
  pull. Without groups, small parts join the larger part they connect to. It returns positions, a score (ratsnest,
  overlaps, courtyard clashes, parts outside) and the outline it used; `placementChanges` turns the positions into
  ordinary edits.

**Tools ▸ Auto Place Footprints…** runs the same placement from the editor without a model: all unlocked footprints
or the selected ones, committed as one undo step like any other edit. `scripts/place-bench.mjs` forgets a finished
board's placement and tracks, places and routes it again and compares with the hand layout;
`scripts/autoplace-ui.mjs` is the two-browser test.

Fine-pitch parts: a connection that ends on a surface pad narrower than its class's track runs narrower (pad width
less 0.1 mm, never below the board minimum), and where a pad's row falls between grid rows the track leaves the pad
straight along its axis off the grid and joins the grid outside, each piece checked exactly.
