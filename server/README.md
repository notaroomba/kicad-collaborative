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

## Roles and sharing

Who may do what is decided in one place, `src/access.rs`, and asked by every handler: the
web editor, the desktop clients (same HTTP and WebSocket endpoints) and the MCP endpoint
get the same answer.

| Role | Reads the design, comments and history | Comments, replies, resolves | Edits, saves versions, syncs with GitHub | Invites, makes links | Changes roles, removes people, settings, delete, transfer |
|---|---|---|---|---|---|
| viewer | yes | no | no | no | no |
| commenter | yes | yes | no | no | no |
| editor | yes | yes | yes | only with "editors can share" | no |
| owner | yes | yes | yes | yes | yes |

A role is held as the owner, as a member (invited by GitHub username or email, or by joining
through a share link), or as a visitor: of a public project, or of a project whose share link
was opened in this browser (cookie `kc_links`, set by `GET /j/{token}`). A visitor who is not
signed in only ever reads. A link that was opened but not joined only ever reads; joining
(`POST /api/join/{token}`, or `POST /api/projects/{id}/join` for the link already opened)
makes its holder a member with the link's role. A link never lowers a role and never
overrides one the owner set by hand.

Someone who is not signed in may also watch live: a browser `hello` with no token is a guest
(`hello_ok.guest`, peer name "Guest", user id 0) who may join documents they can read and
whose ops are refused. Native clients must sign in.

Per-project settings (`PATCH /api/projects/{id}/permissions`, owner):

| Setting | Default | Meaning |
|---|---|---|
| `publicRole` | `viewer` | what a signed-in visitor of a public project may do (`viewer` or `commenter`) |
| `editorsCanShare` | off | editors may invite people and make links, and take back the ones they made |
| `viewersCanCopy` | on | off: Download .zip and Clone are refused for viewers and commenters |
| `linksRequireSignin` | off | on: an opened link shows nothing until its holder signs in |

Every change (role, removal, link turned off, a setting) reaches sessions that are already
connected within about a second: the socket is dropped from documents it may no longer see,
and is told its new role (`{type:"role", docId, role}`) when it changed.

`/api/projects/{id}/info` and `/api/projects/{id}` carry `role` and `can: { edit, comment,
copy, share, manage, join }` for the interface to follow; the server decides again on every
request.

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
| GET/POST | `/api/projects/{id}/links` | list the share links that still work, with `label`, `uses` and who made each · create one (`role`: editor, commenter or viewer; optional `expiresInDays`, `label`) |
| POST | `/api/projects/{id}/join` | join through the share link this browser already opened |
| GET/PATCH | `/api/projects/{id}/permissions` | the permission settings and what the caller may do · change the settings (owner) |
| POST | `/api/projects/{id}/invites` | invite by login/email (instant grant when the account exists, else pending) |
| PATCH/DELETE | `/api/projects/{id}/invites/{inviteId}` | change the role a pending invite grants · revoke it |
| GET | `/api/projects/{id}/members` | who has access: owner, members, `canManage`, `canShare`, `myRole`, `permissions`; any member may read it, pending invites are shown to whoever sent them and to the owner |
| PATCH/DELETE | `/api/projects/{id}/members/{userId}` | change a member's role · revoke access (owner); both reach sessions that are already connected |
| GET/POST | `/api/projects/{id}/versions` | list versions · save one `{name, description, at?}` |
| PATCH/DELETE | `/api/projects/{id}/versions/{vid}` | rename or describe · delete a version |
| POST | `/api/projects/{id}/versions/{vid}/restore` | restore a version |
| POST | `/api/projects/{id}/restore` | restore `{versionId}`, `{name}` or any point `{at:{docId,seq}, scope, label}` |
| GET | `/api/projects/{id}/timeline` | versions, runs of edits, branches: what the History pane shows |
| GET | `/api/docs/{id}/at/{seq\|head}` | the document at that point: `{file, ops}` (`?span=1` adds the ops up to the next snapshot) |
| GET | `/api/docs/{id}/history` | the document's runs of edits |
| GET/POST | `/api/projects/{id}/branches` | list branches · start one `{name, from?}` |
| PATCH/DELETE | `/api/projects/{id}/branches/{bid}` | rename · delete a branch |
| POST | `/api/projects/{branchId}/merge` | merge `{direction: into_main\|from_main, mode, prefer, dryRun}` |
| POST/GET | `/api/projects/{id}/checkpoints` | the older names for saving and listing versions (older desktop builds) |
| GET/POST | `/api/docs/{id}/comments` | a document's comments · add one `{x, y, body, parentId?, anchor?}`; `anchor` is `{kind: item\|net, id, label, item?}` (roots only) |
| PATCH/DELETE | `/api/comments/{id}` | `{resolved}`, `{body}` (the author), `{anchor, x, y}` or `{unpin: true}` to move a thread · delete (the author or the owner) |
| GET | `/api/projects/{id}/comments` | every thread of the project with its document: `{comments, docs}` |
| GET | `/api/projects/{id}/github/commits?path=` | the commits of the linked repository that touched a project file |
| GET | `/api/projects/{id}/github/file?path=&sha=` | that file at a commit |
| POST | `/api/docs/{id}/snapshots?seq=N` | upload a snapshot |
| GET | `/api/docs/{id}/snapshots/{seq}` | fetch a historical file |
| DELETE | `/api/links/{token}` | revoke a share link |
| GET | `/ws` | the sync WebSocket |

## Version history and branches

The server keeps a document as whole-file snapshots (written by the editors)
and a journal of ops after them. Any **point** of a document is a snapshot plus
the ops up to a sequence number, so nothing has to be stored to make history
scrubbable: `GET /api/docs/{id}/at/{seq}` hands a client the snapshot and the
ops to lay over it.

- A **version** pins one point per document of the project (`versions`,
  `version_docs`). Somebody saves one with a name; the server keeps one by
  itself before every restore, merge and GitHub pull, so each of those can be
  taken back. Two versions may share a name; each has its own author and time.
- **Restore** never rewrites history. It appends: the restored content becomes
  a new snapshot at the head, marked by an op from the client id
  `server:reset`, and every connected editor is told to reload. Anyone who can
  edit can restore.
- A **branch** is a child project (`projects.parent_id`) with copies of the
  documents, edited apart from the main line. It shares the parent's access
  and never shows in a project list. **Merging** replays what one side did
  since the two last met onto the other, as ops from `branch:<docId>`. Items
  changed on both sides are reported first (`dryRun`), and the caller chooses
  whose version to keep; `mode: replace` makes one side read exactly as the
  other. A side whose history was restored or pulled since they last met can
  only be replaced, which the dry run says.
- Every change to the list is announced to all connected clients (`versions`
  message), so the History pane never needs a refresh.
- Tests: `scripts/versions-e2e.mjs` (81 checks over the API with two live
  clients) and `scripts/versions-ui.mjs` (two browsers through the web editor;
  takes `BOARD`, a folder with a KiCad project, and `SHOTS` for screenshots).
- The full op history is kept for 30 days. Snapshots and ops that a version or
  a branch needs are kept for as long as it exists.

## Design review

**Comment threads** are pinned to what they are about. Right-click a part to
"Add Comment on R1…", a track, wire or label to "Add Comment on Net VCC…", or
an empty place to comment on the spot. A part's pin sits on its corner and
moves with it; a net's pin is square and opening the thread lights the whole
net. When the item is deleted the thread stays where it was, greyed. Threads
can be replied to, edited by their author, resolved and reopened; all of it
reaches everyone in the document at once. The Comments pane lists the open and
resolved threads of the open document and of the project's other documents.
A thread is stored with `anchor: {kind, id, label, item}`: an item's uuid, or
a net's name and the item it was started on.

**Compare** (File ▸ Compare Schematic/Board with History..., or `?compare=1`
on an editor link) shows what changed between two versions of a sheet or a
board. Either side can be the document as it is now, a version or checkpoint,
a commit of the linked GitHub repository, or a file from the computer. Items
are matched by uuid; what was added, removed or modified is listed (the tracks
of a net as one row) and drawn in KiCad's diff colours as an overlay, side by
side, or with a swipe divider. Selecting a change shows its properties before
and after; "Comment on Change…" starts a thread on that item. A live side
follows edits made while the window is open. Other code opens it with
`window.CollabReview.openCompare({ a, b })` (web/review/sources.ts lists the
version references).

The code is in `web/review/` (the diff engine has its own tests, `npm run
test:review`) and `web/editor/comments.ts`; `scripts/review-ui.mjs` drives
both features with two people in two browsers.

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

## Designing with an AI assistant

There is no chat inside the editor and the server holds no model API key. An AI assistant works on a
project from outside, through the MCP endpoint (next section). Any model or service that speaks MCP
will do (Claude, ChatGPT, Gemini, Copilot, Cursor, a local model behind an agent), so the work runs
on whatever plan or key the person already has instead of on API tokens the server pays for. The
menu bar's **AI** button opens the page that connects one.

The design tools (`web/ai/`: `design.ts`, `proposals.ts`, `library.ts`, with `tools.json` as their
catalog) read components, nets, ERC/DRC and board statistics from the live document and turn
structured edits into ordinary collaboration ops. They run in the browser for plugins and in the
headless editor behind the MCP endpoint.

### The Python harness

`server/harness` is `kicad_harness`, a Python package that drives a design with plain calls
(`sch.place`, `sch.connect`, `sch.build(netlist)`, `board.autoplace`, `board.route`, `parts.from_datasheet`),
so a model writes one short script instead of making a tool call per edit and reading coordinates
back. It is a thin layer: every call becomes edits for the same tool modules, so there is one
implementation of placement, connectivity, checks, the placement engine and the autorouter. Its own
README has the API. It reaches a design three ways, with the same calls:

- **Local files**: `kh.open(folder)` runs the engine with Node (`web/harness/cli.ts` and
  `workspace.ts`, bundled to `static/dist/harness-engine.js`) on KiCad files, no server involved.
- **An online project from outside**: `kh.connect(url, token, project)` goes through `/mcp`.
- **`run_python`**, an MCP tool: the assistant sends a script, the server runs it and returns only what
  the script printed. The script runs in a process of its own (`web/harness/sandbox.ts`): Pyodide
  under Node's permission model with no file, network, child process or environment access and
  JavaScript code generation disabled; its only way out is a blocking call to the headless editor,
  which runs it as the tool of that name. A script that fails is rolled back as a whole; a script
  that succeeds is one undo record per document.

**Live mode.** Edits made through `run_python` (and `apply_changes` with `live`) are sent a few
items at a time, each step its own op with the peer's cursor and selection on what it just drew
(`DocSession.commit` in `web/mcp/session.ts`), so people in the document watch the design being
drawn. A change takes about two seconds however large it is; `live: false` applies it at once.

**Parts.** `parts.from_datasheet` reads a datasheet's pin table and package dimension table and
makes a KiCad symbol and an IPC-7351B footprint (KiCad's own library footprint when it has the
package; JEDEC standard dimensions, with a warning, when the datasheet has no table). `parts.find`
and `parts.lookup` search LCSC, Mouser and DigiKey and resolve Texas Instruments and Analog Devices
part numbers to their datasheets.

**What it saves.** Measured on the same RP2040 dev board (37 parts, 51 nets, placed and fully
routed on two layers) built both ways against a local server:

| | tool calls | written by the model | read by the model |
|---|---|---|---|
| one tool call per step (`get_library_part`, `apply_changes` with coordinates, ...) | 32 | 37,400 characters | 73,900 characters |
| `run_python` (`harness/examples/rp2040_devboard.py`, schematic then board) | 3 | 7,300 characters | 2,700 characters |

That is about a fifth of the output and a twenty-seventh of the input, before counting that every
earlier result is read again on each later call. A part from a datasheet is one call and a
500-character report instead of about 6,000 characters of symbol and footprint text plus the
datasheet pages.

- **Datasheets, cheaply.** A PDF is read with `read_datasheet` (`POST /api/ai/datasheet`,
  `src/datasheet.rs`): the server downloads it once, keeps the text of every page in Postgres for
  everybody, and answers a question with the one to three pages that match (or pages by number),
  about two thousand tokens instead of the whole document. Only public https addresses are fetched.

| Endpoint | |
|---|---|
| `GET /api/kicad-lib/search?kind=symbol\|footprint&q=` | search KiCad's libraries by name (index built on first use, cached a day) |
| `GET /api/kicad-lib/list?kind=&lib=` | libraries, or the items of one |
| `GET /api/kicad-lib/item?kind=&lib=&name=` | one symbol (`.kicad_sym`) or footprint (`.kicad_mod`) |
| `GET /api/docs/{id}/ops?since=N` | the ops applied to a document after snapshot `N`, so another document of the project is read as it is now |

| Variable | |
|---|---|
| `KICAD_LIBS_URL`, `KICAD_LIBS_REF` | where KiCad's libraries are read from (default `https://gitlab.com`, `master`); `scripts/kicad-libs-mirror.mjs` is a caching mirror for machines whose outbound traffic goes through a proxy |

## MCP server (any AI model or service)

`/mcp` is a Model Context Protocol endpoint, so an AI assistant (Claude, ChatGPT, Gemini, Copilot, Cursor, or any other MCP client) can work on a
person's online projects from outside the editor: list and open projects, read schematics and boards, look at
them as pictures, run the checks, find parts, and make changes that everyone in the project sees live.

Connecting (the same steps are on the site's **Connect an AI assistant** page, `/connect`, with the address filled in):

- **Claude Code**: `claude mcp add --transport http kicad https://<site>/mcp`, then `/mcp` inside Claude Code,
  pick `kicad` and sign in.
- **claude.ai and the desktop app**: Settings, Connectors, Add custom connector, paste `https://<site>/mcp`.
- **ChatGPT**: Settings, Apps and connectors, Developer mode on, Create, paste the address.
- **Cursor** (`~/.cursor/mcp.json`): `{"mcpServers":{"kicad":{"url":"https://<site>/mcp"}}}`.
- **VS Code with Copilot** (`.vscode/mcp.json`): `{"servers":{"kicad":{"type":"http","url":"https://<site>/mcp"}}}`.
- **Gemini CLI**: `gemini mcp add --transport http kicad https://<site>/mcp`. **Codex CLI**: `codex mcp add kicad --url https://<site>/mcp`.
- Anything else that speaks MCP over Streamable HTTP with OAuth works the same way; nothing in the server is
  specific to one vendor.
- **Access keys**, for a service that cannot open a sign-in page (a model API's remote MCP tool, an automation,
  an agent around a local model): `/connect` makes a key (`POST /api/mcp/keys`, shown once, stored hashed, valid
  a year, read only unless changes are allowed) that is sent as `Authorization: Bearer <key>`. It is listed with
  the connected apps and removed there.

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
- **Tools** (`src/mcp.rs`, `web/mcp/`): the design tools are the shared ones (`web/ai/tools.json`,
  `design.ts`, `proposals.ts`, `library.ts`), not a second implementation. They are written against the web
  editor's document model, so the server runs them in a **headless editor**: a Node process per signed-in
  person (`web/mcp/host.ts`, bundled to `static/dist/mcp-host.js` and embedded in the binary) that joins the
  document over the ordinary collaboration WebSocket as a peer named "Name (App)", keeps it in step with
  everyone's edits, and sends its own as ordinary ops. Nothing about a change made this way is special to the
  desktop app or the web editor.
- **Changes apply at once.** The person's own AI client already asks before a tool runs, so `apply_changes`
  applies immediately (with `dry_run` to look first). Every call is recorded (`mcp_changes`) with what it takes to
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
| `read_datasheet` | the pages of a PDF datasheet that answer a question (fetched and indexed once on the server) |
| `run_python` | a Python script on the design with `kicad_harness`: the cheap way to do anything beyond a couple of edits (see above) |
| `apply_changes` | every structured edit: symbols, wires, labels, fields, moves, `update_from_schematic`, `auto_place`, `set_rules`, `autoroute`, raw items |
| `undo_changes`, `redo_changes`, `list_changes` | the record of what was changed through MCP |
| `list_comments`, `add_comment`, `resolve_comment` | review comments pinned on the design |
| `list_checkpoints`, `create_checkpoint` | named versions |
| `get_geometry` | every part with its pins' positions and nets, and the wires or outline: what scripts plan from |
| `get_design_guide` | the drawing, layout, routing and review standards and the Python API, for the model to read |

Prompts `review_design`, `tidy_schematic` and `design_board` appear as slash commands in clients that show them.

| Variable | |
|---|---|
| `KC_NODE` | the `node` to run the headless editor with (default `node` on the PATH; Node 20 or newer). The Docker image includes it. Without Node the endpoint still answers, the project and change-list tools work, and the design tools say the editor is unavailable. `run_python` also needs the Python runtime (`static/dist/pyodide`, built by `npm run build`, in the image at `/usr/local/share/kicad-collab/pyodide`; `KC_PYODIDE_DIR` overrides) |
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
bound, the presence size cap, and the role and permission rules (access.rs).

Roles and sharing end to end, against a local server on a throwaway database (see
`scripts/e2e.mjs` for how to start one): `scripts/roles-e2e.mjs` drives every role, share
links with and without an account, guests on the live session, the permission settings and
MCP over the real HTTP and WebSocket endpoints (119 checks); `scripts/roles-ui.mjs` does the
same in real browsers, five people on one project (35 checks, `SHOTS=dir` keeps screenshots).

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

`server/scripts/harness-e2e.mjs` is `run_python` end to end against a running server: a schematic
and a routed board made by scripts while a second collaboration client checks that the edits arrive
step by step with the cursor moving, a failing script rolled back, undo, and the sandbox (no files,
network, environment, JavaScript or processes; a script that never ends is stopped).
`python -m unittest discover -s tests` in `server/harness` tests the package on local files.
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

## Fabrication outputs

File > Fabrication Outputs in the board editor writes what a manufacturer builds from, in the
browser, from the live board: Gerbers (RS-274X with X2 attributes), Excellon drill files, the
component placement file and the bill of materials, and downloads them as one archive.

| Preset | What it writes |
| --- | --- |
| JLCPCB | Copper, paste, legend, mask and outline with Protel extensions, X2 attributes as comments, the drill/place origin, mask subtracted from the legend; `gerbers.zip` for the order page, `bom.csv` (`Designator, Footprint, Quantity, Value, LCSC Part #`) and `positions.csv` (`Designator, Mid X, Mid Y, Rotation, Layer`) for assembly, with JLCPCB's rotation corrections by package and the `JLCPCB Rotation Offset` / `JLCPCB Position Offset` fields honoured |
| PCBWay | The same Gerbers and drill files, `bom.csv` and `centroid.csv` in the columns of PCBWay's assembly templates |
| KiCad defaults | Every layer KiCad's Plot dialog ticks, `.gbr` names, page origin, and the drill, placement and BOM files as KiCad's own dialogs write them |

The dialog lists the files with a drawing of each layer as plotted, reports what an order form
would bounce (no outline, zones without a fill, BOM lines without a part number) and lets the
layers and options be changed before the download. The same four menu entries (Gerbers, Drill
Files, Component Placement, Bill of Materials) open it on their kind of file.

The writers are `server/web/fab` (`prims.ts` plot primitives, `model.ts` pads, vias, tracks and
zones read from the board, `plot.ts` pcbnew's layer plotting order and rules, `gerber.ts`,
`drill.ts`, `parts.ts` placement and BOM, `presets.ts`, `zip.ts`), built into
`static/dist/fab.js` and loaded on first use. They are also `window.KiCadFab` for plugins and
scripts: `KiCadFab.buildPackage({ doc, setup }, { preset })`, `plotGerbers`, `drillFiles`,
`positions`, `bom`. Polygon work (custom pads, mask margins, the solder mask minimum width)
uses clipper2-ts, the library pcbnew's own polygon code is built on.

The output is held against KiCad's own. `scripts/fab-verify.mjs` writes every layer of a board
with both, draws both with gerbv on the same window and compares the pixels, and compares the
drill and placement files as text:

```bash
KICAD_CLI=/path/to/build/kicad/kicad-cli node scripts/fab-verify.mjs ../demos/pic_programmer/pic_programmer.kicad_pcb
```

Against this tree's kicad-cli, every layer, the drill files and the placement file match on all
twenty boards in `demos/` (two to ten copper layers, through-hole and fine-pitch, custom pads,
zones, dimensions, slots, back-side parts, knockout text, TrueType text; the Jetson AGX Thor
baseboard is the largest, with 3,348 holes and 1,003 placed parts), with and without the
drill/place origin and mask subtraction.

Text set in a TrueType font is plotted from the outlines KiCad stores with it in the board file,
which is what pcbnew itself plots. The outlines follow a text that is moved in the browser; a
text whose wording, size or angle is changed here loses them, and is plotted in KiCad's stroke
font with a warning in the dialog until the board is next saved from KiCad. For the comparison
the fonts a board names must be installed for kicad-cli (`fonts-ubuntu`, `fonts-lato`,
`fonts-freefont-ttf`, `fonts-liberation` cover the demos), or it substitutes another face.

`static/tests/fab.test.js` (part of `npm test`) covers the writers on a small board, and
`scripts/fab-ui.mjs` drives the dialog in a browser and checks the downloaded archives.

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

### Signal domains, ground via fences and keepouts

- **Net kinds** (`PcbAutoRouter.netKind(name)`): analog (ADC and DAC lines, references, audio, sense and feedback,
  crystals), RF (antenna and RF feeds), switching (a converter's switch node, bootstrap and gate drives), fast
  (clocks, differential pairs), supply, and digital for everything else. A net KiCad named after a pin
  (`Net-(U3-SW)`) is judged by the pin's name. `netOpts[net].kind` overrides the name.
- **Separation** (`separate`, on when the board has an analog or RF net): a track of one kind keeps an extra gap from
  the tracks and vias of another: `quiet` mm between analog or RF and digital (default two clearances, at least
  0.3 mm), `noisy` mm between analog or RF and switching or fast (three clearances, at least 0.5 mm). Pads are
  exempt, and so is copper within `nearPads` mm of any pad (default 1.2), since parts sit where they sit and a
  fine-pitch fan-out has no room to give; supply nets are shared by every domain. It is done in the occupancy
  maps (each rule class carries its kind, and an obstacle of another kind is grown by the gap), so it costs nothing
  in the search. A connection that cannot be made with the gap is made without it as a last resort and named in
  `result.domains.relaxed`.
- **Ground via fence** (`fence`): every track of an RF net (and of the nets in `fence.nets`) gets ground vias down
  both sides, `spacing` mm apart (default 2 mm). **Return vias**: each layer change of an RF, clock or pair net gets a
  ground via beside it. A via goes in only where the ground pour lies on two layers and is not cut there, where the
  rules leave room (exact check), and a hole's width from the other ground vias; `result.fences` counts them and
  says why any are missing.
- **Keepouts**: KiCad rule areas on the board are honoured (tracks, vias, and the band a track's half width reaches
  into); `keepouts` adds areas for one run and `netOpts[net].avoid` keeps one net out of an area.
- From Python: `board.route(kinds=..., separate=..., fence=...)` and `board.keepout(box, ...)`; over MCP the
  `autoroute` edit takes `separate`, `fence` and `net_options.<net>.kind`. The design guide (`web/mcp/guide.md`,
  "Keeping signals apart") tells the model how to place by domain and when to use each.

### Planning and judging from outside

The engine does the geometry and keeps the rules; what to route first, on which layers and how wide can come from a
plan — a model, or a person. Everything here is pure (nothing is written to the board):

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
