# Plugins for the web editor

KiCad Collaborative runs plugins in two places.

- **Desktop app.** KiCad's own plugin systems are unchanged: IPC API plugins (`plugin.json` with a
  `python` or `exec` runtime, `kicad-python`), the legacy action plugins, and the Plugin and
  Content Manager. They edit through KiCad's commits, so what they change in an online project
  reaches every collaborator like any other edit. Nothing here applies to them.
- **Web editor.** Plugins are JavaScript that runs sandboxed in the browser of the person who
  installed them. This document is about those.

The folders next to this file are the built-in catalog and are meant to be read as examples:

| Folder | Shows |
|---|---|
| `bom-export` | an exporter and a toolbar action that only read |
| `design-stats` | a docked panel that follows the document and the selection |
| `snap-to-grid` | a dialog, stored settings, and a change to the design |
| `field-lint` | check markers on the canvas and a tool for the design assistant |
| `placement-import` | an importer and an exporter for the board |

## A plugin in two files

`plugin.json` is KiCad's IPC plugin manifest (`api/schemas/api.v1.schema.json`) with a `web`
runtime, so one folder can describe a desktop plugin and a web plugin side by side.

```json
{
  "identifier": "com.example.hello",
  "name": "Hello",
  "description": "Counts the components of the open document.",
  "version": "1.0.0",
  "runtime": { "type": "web", "entrypoint": "main.js" },
  "permissions": ["design:read"],
  "actions": [
    { "identifier": "count", "name": "Count Components", "description": "Say how many there are",
      "scopes": ["schematic", "pcb"], "show-button": true }
  ]
}
```

```js
// main.js
kicad.actions.register("count", async () => {
  const { count } = await kicad.design.components({});
  await kicad.ui.toast(`${count} components`);
});
```

Install it from **Tools → External Plugins → Manage Plugins… → Install from file or URL**: pick
the folder, or give the address of `plugin.json` (a GitHub link works). Load it again after
editing; the installed copy is replaced. The manager shows each plugin's `console` output.

## Manifest

| Key | Meaning |
|---|---|
| `identifier`, `name`, `description` | as in KiCad |
| `version`, `author`, `homepage`, `license` | shown in the manager |
| `runtime` | `{ "type": "web", "entrypoint": "main.js" }` |
| `permissions` | what the plugin may do; see below |
| `actions[]` | commands: `identifier`, `name`, `description`, `scopes` (`"schematic"`, `"pcb"`, or `"footprint_wizard"` for a footprint wizard, see below), `show-button`, `icon` (inline SVG shapes for a 24×24 stroke glyph), `key` (`"Ctrl+Shift+B"`), `menu` (`"tools"` by default, or `"inspect"`, `"edit"`, `"place"`) |
| `panel` | one docked panel: `name`, `html` (a file used as the panel's body), `scopes` |
| `importers[]`, `exporters[]` | entries under File → Import / Export: `identifier`, `name`, `scopes`, `extensions` |
| `assistant_tools[]` | tools the design assistant may call: `name`, `description`, `input_schema` |
| `resources[]` | other text files of the plugin, read with `kicad.resources.text(path)` |

A plugin is at most 40 text files and 2 MB.

## Permissions

A plugin gets nothing it does not list, and the person sees the list before installing. An update
that asks for more is shown again for consent.

| Permission | Allows |
|---|---|
| `design:read` | `kicad.design` reads; `kicad.fab.*`; `kicad.project.versions()`; the `document`, `selection` and `change` events |
| `design:write` | `kicad.design.apply()` and `kicad.design.commit()`; `kicad.project.saveVersion()` |
| `view` | `kicad.view.*`: selection, highlight, view position, markers, opening a document |
| `files:import` | importers; `kicad.files.pick()`; file fields in `kicad.ui.prompt()` |
| `files:export` | exporters; `kicad.files.save()` |
| `assistant` | `kicad.assistant.registerTool()` |
| `network:host.example.com` | `fetch` to that host over https (one entry per host) |
| `network` | KiCad's own Python plugins only: web requests carried by the server to the addresses the plugin's package names (see below) |

No permission is needed for `kicad.ui`, `kicad.storage` or `kicad.resources`.

## The `kicad` object

Every call returns a promise. A refused call rejects with an `Error` whose `code` is one of
`permission_denied`, `view_only`, `invalid`, `not_found`, `no_document`, `too_large`,
`rate_limited`.

**Registering**

- `kicad.actions.register(id, async ({ editor }) => {})`
- `kicad.exporters.register(id, async () => ({ filename, mime, text }))` (or `bytes`)
- `kicad.importers.register(id, async ({ name, size, text, bytes }) => {})`
- `kicad.assistant.registerTool(name, async (input) => result)`
- `kicad.wizards.register(id, async (req) => state)`: a footprint wizard, for an action of scope `"footprint_wizard"`.
  The footprint editor's Create Footprint lists it and asks `{ op: "describe" }`, `{ op: "build", values }` (every
  page's values, as strings, in order) or `{ op: "reset" }`; it answers `{ name, description, pages: [{ name, params:
  [{ name, value, units, hint, error }] }], messages, footprint }`, `footprint` being `.kicad_mod` text (or null when
  the values have errors).  `units` is `mm`, `mils`, `integer`, `float`, `bool` (`"1"`/`"0"`), `degrees`, `radians`,
  `%`, `string` or a list of choices `"a,b,c"`.  A Python plugin's `FootprintWizardPlugin` is offered the same way.
- `kicad.on(event, fn)` with `"document"`, `"selection"`, `"change"`, `"editor"`, `"theme"`

**Reading** (`design:read`). These return the same facts the design assistant reads.

- `kicad.design.overview()`, `documents()`, `boardInfo()`, `selection()`
- `kicad.design.components({ doc?, filter?, includePower? })`, `component({ ref, doc? })`
- `kicad.design.nets({ doc?, filter? })`, `runChecks({ doc? })`
- `kicad.design.items({ doc?, kinds?, ids?, near?, limit?, sexpr? })`: items in full, with their
  KiCad s-expression unless `sexpr: false`

**Changing** (`design:write`). Both apply to the open document and are one undo step.

- `kicad.design.apply({ title, edits })`: structured edits. `set_field`, `move`, `remove`,
  `add_symbol`, `add_wire`, `add_label`, `add_junction`, `add_no_connect`, `add_text`,
  `add_track`, `add_via`, `add_item`. This is the grammar the assistant's proposals use.
- `kicad.design.commit({ label, create: [sexpr], update: [{ id, sexpr }], remove: [id] })`: raw
  items. Each s-expression must be exactly one item the document can hold.

**View** (`view`): `kicad.view.select({ ids?, refs? })`, `highlight()`, `focus({ ids?, refs?, x?, y? })`,
`setMarkers({ markers: [{ x, y, severity, text, ids }] })`, `clearMarkers()`, `openDocument({ doc })`.

**Interface**: `kicad.ui.toast(text)`, `status(text)`, `confirm({ title, message, okLabel })`,
`prompt({ title, message, fields, okLabel })` with field types `text`, `number`, `select`,
`checkbox`, `textarea`, `file`; `showPanel()`, `hidePanel()`. Dialogs are drawn by the editor and
carry the plugin's name.

**Fabrication and checks** (a board must be open): `kicad.fab.layers()`, `gerbers(options)`,
`drill(options)`, `positions(options)`, `bom(options)` return the files File → Fabrication Outputs
makes; `svg({ layers, commonLayers, single, mirror, blackAndWhite, area })` draws layers as SVG;
`drc({ parity })` runs the Design Rules Checker and returns its markers; `netlist()` returns the
project's schematic as components and nets.

**Versions**: `kicad.project.versions()` lists the project's saved versions;
`kicad.project.saveVersion({ name, description })` saves one, or opens the Save Version dialog
when no name is given.

**Files**: `kicad.files.save({ filename, mime, text | bytes })`, `kicad.files.pick({ accept, as })`.

**Storage**: `kicad.storage.get(key)`, `set(key, value)`, `remove(key)`, `keys()`. Kept in the
browser, per person and plugin, 512 KB.

**Context**: `kicad.plugin` (identifier, name, version, permissions) and `kicad.editor` (scope,
role, viewOnly, document).

## Panels

The frame a plugin runs in is its panel. `panel.html` becomes the body and ordinary DOM code draws
into it. The app's colour tokens (`--paper`, `--bench`, `--panel`, `--line`, `--ink`, `--ink-2`,
`--ink-3`, `--blue`, `--copper`, `--err`, `--warn`, `--wire`, `--font`, `--mono`) are set on the
frame's root and follow the light and dark themes, and plain `button`, `input`, `select` and
`table` elements are already styled with them. Use the tokens; do not hard-code colours.

## Sharing a plugin

**Publish it.** Install your plugin from a file or an address, open it in the Plugin Manager and
choose **Publish…** under Sharing. That lists your copy in the community registry (Catalog tab,
Community section) under your account name, where anyone can search for it and install it. The
manifest needs a `version`; publish again after loading a newer copy and people who have it are
offered **Update…**, with any new permission pointed out. The identifier is yours from the first
publish, and **Unpublish** takes the listing down again (people who installed it keep their copy).
Identifiers under `dev.notaroomba.kicad-collab.` are the built-in catalog's.

Publishing shares a copy and nothing else. Community plugins are not reviewed: whoever installs
one is told who published it and sees every permission before it is stored.

**Recommend it to a project.** With a project open, an editor can tick **Recommend to this
project's collaborators** on a built-in or published plugin. Everyone who opens the project then
sees a notice across the top of the canvas and the list under **This project** in the manager. A
recommendation is a pointer: each person installs for themselves through the same consent sheet,
and nothing is installed or run for anyone who does not. A private plugin (from a file or an
address) has to be published first, so collaborators have somewhere to get it.

**Reports and moderation.** Anyone signed in can report a community plugin from its card
(**Report a problem…**). The server's administrators are the GitHub logins listed in the
`KC_ADMINS` environment variable (comma separated); they get a **Moderation** tab in the Plugin
Manager showing every reported plugin with the reports. From there they can dismiss the reports,
**hide** the plugin (reversible) or **remove** it for good, giving a reason. Hiding or removing
takes the plugin out of the registry and out of project recommendations, and switches off the
copies people installed from the registry; each of those people, and the publisher, is shown the
reason. The copies stay with their owners, who can uninstall them or switch them back on. A
hidden or removed plugin cannot be published again under the same identifier, and restoring a
hidden one lists it again without switching anyone's copy back on. With `KC_ADMINS` unset there
are no administrators and reports simply wait.

The endpoints: `GET /api/plugins/registry?q=`, `GET|PUT|DELETE /api/plugins/registry/{identifier}`,
`POST /api/plugins/registry/{identifier}/report`, `GET /api/plugins/moderation`,
`POST /api/plugins/registry/{identifier}/moderate`, `GET /api/projects/{id}/plugins`,
`PUT|DELETE /api/projects/{id}/plugins/{identifier}`.

## How plugins are contained

- A plugin runs in an `<iframe sandbox="allow-scripts">` with an opaque origin. It cannot reach
  the page, its cookies or storage, cannot call the server as the signed-in person, and cannot
  open windows or navigate the tab.
- A Content-Security-Policy in the frame denies every network load except the hosts granted with
  `network:`. The app page's own `frame-src 'none'` stops the frame from navigating itself away.
- Its only way out is a message channel. Each request is checked against the permissions the
  person granted before the editor acts on it.
- Plugins belong to an account, not to a project. Installing one never runs code for a
  collaborator. A plugin acts with its person's access, so a viewer's plugin cannot write.
- A change goes through the editor's normal commit: applied locally, sent as a collaboration op,
  visible to every peer, one undo step, recorded by checkpoints. Writes are limited to 2000
  changes per step and 30 steps in ten seconds.
- The server stores the copy and never fetches a plugin from an address itself.

Known limits. A plugin with `design:read` and a `network:` host can send what it reads to that
host, which is why the consent screen marks the pair. A plugin's script shares the browser's main
thread on browsers that do not put sandboxed frames in their own process, so a plugin stuck in a
loop can stall the tab there. WebRTC is not covered by the frame's policy.

## KiCad's own Python plugins

The plugins in KiCad's Plugin and Content Manager are Python programs written for the desktop's
`pcbnew` and `wx` modules.  The web editor runs them as they are: the Plugin Manager's
**Catalog** lists KiCad's repository beside the built-in and community plugins (each card says
where it comes from, with each plugin's own icon), and installing one stores the package with your
account like any other plugin.

How it works:

- A Python plugin is an ordinary sandboxed web plugin whose manifest says
  `"runtime": { "type": "kicad-python" }`.  Its entry script (`web/plugins/pyruntime.ts`) starts
  CPython compiled to WebAssembly (Pyodide) inside the plugin's frame and gives it this editor's
  `pcbnew`, `wx` and `FootprintWizardBase` modules (`plugins/python/`).  It has exactly the reach
  any web plugin has: the `kicad` API, checked against the permissions the person granted.
- `pcbnew.GetBoard()` is the open board.  What the plugin changes is sent as one collaborative
  edit when it finishes (or calls `pcbnew.Refresh()`): one undo step, seen by everyone.
  Footprints moved, turned or flipped go through the editor's own transforms.
- `wx` windows are HTML inside the frame, floated by the editor as a KiCad dialog.
  `ShowModal()` blocks as on the desktop.  Message boxes, file pickers and progress dialogs are
  drawn by the editor.
- `PLOT_CONTROLLER` (Gerber), `EXCELLON_WRITER`, `PLACE_FILE_EXPORTER` and `IPC356D_WRITER` use
  the editor's fabrication writers (`kicad.fab.*`), so a manufacturer's plugin produces the files
  File → Fabrication Outputs makes.  Files a plugin writes beside the board are handed to the
  person as a download (a zip when there are several).
- The project file and the schematics are beside the board, so net classes, design rules and
  plugins that read the schematic work.
- The interpreter starts the first time one of the plugin's commands is used in a project
  (two to five seconds), then stays for the session.
- **Plugins for KiCad's IPC interface** (a `plugin.json` and the `kicad-python` package, `kipy`)
  run the same way.  The real `kipy` is installed; the socket it talks through (`pynng.py`) is a
  function call answered by `kicad_ipc.py`, which serves the API's commands from the open board:
  reading and creating, changing and deleting items, commits (one undo step each), the selection,
  nets and net classes, layers, the stackup, the title block, zone refill.  Each action of
  `plugin.json` becomes an editor command that runs the entry script as a program.
- **Python packages.**  `plugins/python/packages.json` lists the packages plugins ask for.
  `scripts/build-python.mjs` (part of `npm run build`) downloads them into the runtime folder:
  Pyodide's own builds (numpy, pillow, shapely, scipy, matplotlib, pandas and others) from Pyodide's
  CDN, and pure Python wheels (protobuf, kicad-python, openpyxl) from PyPI at pinned versions with
  their SHA-256.  A plugin's imports are scanned when it starts and only the packages it uses are
  loaded.  A build that cannot reach Pyodide's CDN leaves the compiled packages out; plugins that
  need them then say which module is missing.
- **Programs and threads.**  A plugin that starts Python again (`subprocess` with
  `sys.executable`) has that script run in the same interpreter.  Threads run in turn; a thread
  that only waits and polls is parked, and a worker that waits on a `queue.Queue` runs when
  something is put on it.  Listening on a socket is refused.
- **kicad-cli and git.**  Two desktop programs have an equivalent in the editor, and
  `plugins/python/kicad_programs.py` answers for them (`shutil.which` finds them, `subprocess`
  runs them).  `kicad-cli`: `version`, `pcb drc` (the Design Rules Checker's own run, written as
  KiCad's JSON or text report), `pcb export gerbers`, `gerber`, `drill`, `pos` and `svg` (the
  fabrication writers), `sch export netlist` and `bom` (the project's schematic).  They work on
  the design as it is open, and the files land where the plugin asked.  The web DRC checks fewer
  rules than the desktop's and does not refill zones; the stand-in says so on stderr and in the
  plugin's log.  `git`: `version`, `rev-parse`, `status`, `log`, `add`, `commit` and `gui`, on
  the project's version history: a commit is a saved version, `git gui` opens the Save Version
  dialog.  Any other subcommand, and any other program, is refused with a message, never faked.
  `pcbnew.SaveBoard` writes the board as a file in the interpreter's file system.
- **Qt.**  Plugins for the IPC interface that draw with PySide6 get `plugins/python/PySide6`:
  Qt's Python interface (widgets, layouts, signals and slots, models and views, QThread, QTimer,
  QSettings) on the same HTML widgets `wx` uses, so a `QMainWindow` is a KiCad dialog.  Custom
  painting (`QPainter`) is accepted and draws nothing.
- **Footprint wizards.**  `FootprintWizardBase` and `PadArray` are KiCad's own helper modules.
  Each wizard a plugin registers becomes a command, "Footprint Wizard: <name>", that opens the
  wizard dialog (`kicad_wizard.py`): the parameter pages, a live preview, the build messages,
  *Save Footprint* (a `.kicad_mod` file) and *Place on Board* (one undoable edit).
- **The network.**  A plugin frame cannot open connections.  A plugin from KiCad's repository
  whose code talks to web services is offered the `network` permission, and the consent dialog
  lists the addresses.  With it, the plugin's sockets (so `urllib`, `http.client`, `requests`) are
  carried as HTTP requests by the server, `POST /api/plugins/pcm/{identifier}/fetch`, which:
  takes the allowed addresses from the plugin's own package as published in KiCad's repository,
  never from the browser; allows https on the standard port to public addresses only (the name is
  resolved once and the connection pinned to that address); does not follow redirects; sends none
  of the person's cookies; limits a request to 16 MB, an answer to 24 MB and a person to 240
  requests a minute.  Every request is written to the plugin's log.
  `KC_PLUGIN_NETWORK=off` turns this off for the whole server.

- **Local ports and helper programs.**  A plugin that listens on `127.0.0.1` and starts a second
  Python program that connects to it (TraceForge's helper and panel) gets both inside the page:
  `kicad_net.py` pairs a loopback `connect` with a `listen` in the same interpreter, each
  `threading.Thread` runs as a parked task that is resumed when its socket has work, and
  `Event.wait` lets the page breathe.  Nothing leaves the page and nothing outside it can
  connect; a loopback address with no listener in the page is refused, unless the plugin's
  package lists it as a web service address, in which case the server carries it as above.
- **The board editor window.**  `pcbnew.GetBoard()`-era plugins that find the "PCB Editor" frame
  with `wx.GetTopLevelWindows()` get a stand-in (`wx._PcbFrame`): its menu bar holds Edit
  (Undo, Redo, which undo and redo in the real editor) and Tools, External Plugins; its canvas
  child receives the person's selection as clicks and key presses; its "Appearance" child holds
  a Nets grid and the net colour and ratsnest radio buttons, which read and write the editor's
  own Appearance panel.  `BOARD.SetHighLightNet`/`HighLightON` highlight the nets in the editor.
  A board changed by someone else is reloaded before the plugin's next event handler runs.
- **More of wx.**  `wx.lib.agw.hypertreelist` and `wx.TreeCtrl` (`wx/_tree.py`), accelerator
  tables, `wx.ColourDialog`, screen geometry, `wx.DateTime`.

What does not carry over, by nature of a browser: running programs that are not Python and not
stood in for here (ngspice, FreeCAD, a 3D renderer, a compiled desktop application), a server
on the person's own computer, and Python packages with native code that Pyodide does not ship.
A plugin that needs one of these says so in its log.

The label beside each plugin in the manager is one of *runs here* (it was seen doing its work:
it changed the board, wrote a file, made a fabrication output, or its drive checked the result),
*opens, unverified* (its window opens, but no run has seen it do its work), *partly works*,
*limited*, *not supported* and *not tested yet* (it needs something this check could not load or reach).
`plugins/python/compat-notes.json` holds the labels set by hand, for plugins whose commands run
here but whose purpose needs a desktop program.

The label beside each plugin in the manager comes from `scripts/plugins-python.mjs`, which loads
every official package headless, runs each command it registers against a demo board with the
main button of its dialog pressed, and writes `plugins/python/compat.json`:

```sh
PCM_SRC=<folder of unpacked PCM packages> COMPAT=plugins/python/compat.json node scripts/plugins-python.mjs
node scripts/plugins-python.mjs --one <package folder>      # one package, as JSON
```

The server reads the repository at `https://repository.kicad.org/repository.json`
(`KC_PCM_REPOSITORY` points it elsewhere; `scripts/pcm-fixture.mjs` serves a local copy), checks
each download against its SHA-256 and keeps packages within 1500 files and 12 MB.

## Testing

`server/scripts/plugins-ui.mjs` drives the real editor in Chromium with two people in one project
and covers the manager, every extension point, the collaborative path of a plugin edit and the
sandbox. Its header says how to run it.

`scripts/plugins-python-ui.mjs` does the same for Python plugins: it serves a PCM package of its
own, installs it through the Catalog and drives it with two people, then does the same
with a plugin for the IPC interface and with requests to a web service of its own (start the
server with `KC_PCM_REPOSITORY=http://127.0.0.1:8096/repository.json KC_PLUGIN_NETWORK=test`;
`test` lets an address on this machine stand in for one on the internet and is for tests only).
`cargo test net_tests` covers which addresses the server will carry a request to.
