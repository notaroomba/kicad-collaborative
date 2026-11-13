# Changelog

Releases of Junction, which was called KiCad Collaborative up to 1.0.9. The
version here is the product version (`packaging/VERSION`), not the KiCad
version it is based on.

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
