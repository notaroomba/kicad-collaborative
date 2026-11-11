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
| `actions[]` | commands: `identifier`, `name`, `description`, `scopes` (`"schematic"`, `"pcb"`), `show-button`, `icon` (inline SVG shapes for a 24×24 stroke glyph), `key` (`"Ctrl+Shift+B"`), `menu` (`"tools"` by default, or `"inspect"`, `"edit"`, `"place"`) |
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
| `design:read` | `kicad.design` reads; the `document`, `selection` and `change` events |
| `design:write` | `kicad.design.apply()` and `kicad.design.commit()` |
| `view` | `kicad.view.*`: selection, highlight, view position, markers, opening a document |
| `files:import` | importers; `kicad.files.pick()`; file fields in `kicad.ui.prompt()` |
| `files:export` | exporters; `kicad.files.save()` |
| `assistant` | `kicad.assistant.registerTool()` |
| `network:host.example.com` | `fetch` to that host over https (one entry per host) |

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

## Testing

`server/scripts/plugins-ui.mjs` drives the real editor in Chromium with two people in one project
and covers the manager, every extension point, the collaborative path of a plugin edit and the
sandbox. Its header says how to run it.
