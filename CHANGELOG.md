# Changelog

Releases of Junction, which was called KiCad Collaborative up to 1.0.9. The
version here is the product version (`packaging/VERSION`), not the KiCad
version it is based on.

## 2.1.0 (2026-11-14)

A desktop update with new features since 2.0.0. It reads and writes the same
files as 2.0.0, so people in a project can update one at a time.

### Desktop
- Online Projects is a docked pane in the project manager instead of a modal
  dialog: shown by default, toggled from the left toolbar, View > Panels and
  File > Online Projects. A This Project card says whether the open project is
  local only or synced, with its live session state.
- WakaTime: the editors send heartbeats like WakaTime's own plugins, set up in
  Preferences > Common > WakaTime. Works with WakaTime, Hackatime, Wakapi or any
  WakaTime-API server, reads and keeps `~/.wakatime.cfg`, and uses wakatime-cli
  when it is installed.
- Fonts: every Google Font is in the font list and downloads when picked; a
  font missing on this computer is fetched while the app runs and the text is
  redrawn without a restart. Fonts only you have are shared with the project so
  collaborators draw the same letters, and stored glyph outlines are kept on
  load and on copy.
- Collaborator cursors are bigger, with a filled name tag.

### Files
- Saving keeps KiCad 9 and 10 boards and schematics readable by KiCad 9 and 10.
  Fixed: boards with a layer stackup were raised to a newer format, KiCad 9
  boards were written with nets by name, zones lost their fill thickness flag,
  teardrops lost their ids and old plot layer selections were renumbered.
- A file stamped by a newer KiCad opens when everything in it is known; an
  unknown construct still stops the load, so nothing is dropped silently.
- No more notice when an older KiCad file opens, since it is saved back at its
  own version.

### Web editor and server (already live)
- Many more KiCad dialogs and tools in the browser: Board Setup with an editable
  stackup, Zone Manager, Teardrops, Cleanup Graphics, Remove Unused Pads,
  Geographical Reannotate, Repair Board, Net Inspector, hierarchy-wide ERC,
  inter-sheet references, KiCad's menu bars, mouse and touchpad preferences.
- WakaTime heartbeats from the browser editor, GitHub sync through the
  "KiCAD Junction" GitHub App, and router and placement improvements for
  AI-designed boards.

### Packaging
- The macOS DMG is now built in CI with Windows and Linux, and every release
  run installs and launches all three builds on clean machines before it
  publishes.
- The Linux tarball runs from wherever it is extracted (2.0.0 looked for its
  libraries and data under /usr), and lists the Ubuntu packages it needs in
  `usr/share/junction/ubuntu-packages.txt`.

### Downloads

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon, macOS 15+) | `Junction-2.1.0-macos.dmg` | Ad-hoc signed: first launch is right-click, Open. Replace the old app in Applications. |
| Windows x64 | `Junction-2.1.0-windows-x64.exe` | Installer; upgrades 2.0.0 or KiCad Collaborative in place. |
| Linux x64 (Ubuntu 24.04+) | `Junction-2.1.0-linux-x64.tar.gz` | Extract anywhere, install the packages listed in `usr/share/junction/ubuntu-packages.txt` (`sudo apt install $(cat usr/share/junction/ubuntu-packages.txt)`), run `usr/bin/junction`. |

Symbol and footprint libraries are not bundled; point the library tables at an existing KiCad 10 install.

## 2.0.0 (2026-11-12)

First release since 1.0.9. It is a major version because the desktop app is
now built on a much newer KiCad (2782 upstream commits, through 2026-11-10),
so a 2.0 client can write things into a shared project that a 1.0.9 client
cannot read. Everyone in a project should update together. Files you open
still keep the format version they came with unless an edit needs a newer one.

### New name
- KiCad Collaborative is now Junction. The app, the installers, the web editor
  and the repository (github.com/notaroomba/junction) carry the new name. Your
  settings, sign-in, online projects and the kicad-collab:// links are unchanged.

### Web editor
- The browser editor went from a viewer to a full editor that follows KiCad's
  own tools and dialogs: schematic and board editing, the interactive router
  (drag, differential pairs, length tuning), zones and zone fill,
  DRC and ERC, custom rules, Properties panel, context menus and hotkeys.
- Symbol Editor and Footprint Editor, with library management, the Footprint
  Wizard and KiCad library access (Choose Symbol / Choose Footprint).
- Fabrication outputs from the browser: Gerbers, drill files, placement, BOM
  and plots, checked against kicad-cli on the demo boards.
- 3D viewer, SPICE simulation with ngspice, and the Simulation Model Editor.
- Board autorouter (Route > Autoroute) with differential pairs, impedance from
  the stackup, length matching, signal domains and ground via fences.
- Vendor parts: search LCSC, Mouser and DigiKey and place the symbol and
  footprint, with saved part libraries.
- Plugins: a Plugin Manager with one catalog for built-in, KiCad and community
  plugins, sandboxed and permissioned, including KiCad IPC and Python plugins.

### Projects, sharing and history
- Stored online projects with a web home: blank projects, starter templates,
  stars, Trash and public projects.
- Roles and sharing: a comment-only role, view and comment links that open
  without an account, and per-project permissions.
- Version history and branches on the server, and a visual compare of versions.
- Design review: comment threads pinned to parts and nets.
- GitHub repository sync for online projects: connect, import, push, pull and
  an item-level merge that shows what changed inside each file.

### Desktop
- Merged upstream KiCad master. About says "based on KiCad 10".
- Keep working offline and merge when the connection comes back.
- The History panel lists versions and follows them live, and File has
  Compare Versions.
- Comment threads carry their part or net and their pins follow it.
- Presence carries each selected item's anchor, so a peer's drag is ghosted at
  the exact offset.
- One folder syncs with one online project.
- Fixed two crashes when a tuning pattern is regenerated.

### AI and scripting
- MCP server: any AI model or service that speaks MCP can open, read and edit
  your online projects, with consent and the project's roles enforced.
- Python harness: design by script (`run_python` over MCP) with live drawing,
  schematic blocks drawn like a datasheet application circuit, board routing,
  zones, keepouts and layout checks.
- The in-editor chat is gone. An assistant works on a project through MCP.

### Packaging
- Windows and Linux builds need glslang, spirv-tools, the Vulkan headers and
  SQLite now (upstream's new renderer and database library backend). macOS
  also needs spirv-cross.

## 1.0.9 (2026-09-19)

Wires, symbols and fields sync and preview correctly between two desktop
clients. See the GitHub release for the full notes.
