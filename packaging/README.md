# Packaging KiCad Collaborative

Installers are branded **KiCad Collaborative** and are designed to install
*alongside* a stock KiCad, sharing the same project files.

## Coexistence with stock KiCad

- **Lock files are never created or modified.** Stock KiCad guards open
  projects with `~*.lck` files; KiCad Collaborative reads and honors an
  existing lock but never writes, overwrites or deletes one — live-session
  coordination is the collaboration server's job. Set
  `KICAD_COLLAB_CREATE_LOCKS=1` to restore stock locking.
- **No collab data in project files.** Collaboration metadata (server
  link, session tokens) lives in a `.collab/` directory next to the
  project, never inside `.kicad_pro`/`.kicad_sch`/`.kicad_pcb`.
- **No file associations.** The Windows installer does not register
  `.kicad_*` extensions and the macOS bundle uses its own bundle id, so
  double-clicking a board still opens your stock KiCad.
- **The format version is never touched silently.** Saving a board or
  schematic keeps the `(version …)` stamp the file was opened with, so a
  file that came from stock KiCad 10 still identifies as a KiCad 10 file
  after being edited here and opens there without a "newer format"
  warning. New files, new sub-sheets of a new project, and legacy-format
  imports get the current version; a sub-sheet added to an existing
  project inherits that project's version. Set
  `KICAD_COLLAB_STAMP_VERSIONS` (to any value) to restore stock
  restamping, and `kicad-cli sch upgrade` / `pcb upgrade` still upgrade on
  request.

  The stamp is only kept when the file's contents actually fit in it. Each
  save measures the serialized body against a table of when every token
  entered the format; if an edit has introduced something the old version
  cannot express — a net chain, an ellipse, a pin-to-pad map — the version
  is raised to the oldest one that can hold it and an infobar (or a CLI
  warning) names the feature that forced it. Nothing is written under a
  stamp it does not match without saying so.

  Where a construct merely *changed representation*, the old
  representation is written instead of upgrading, so the file round-trips:
  a bold stroke-font width, for example, is written back with the bold
  multiplier baked in for pre-20260826 files rather than shrinking by the
  multiplier on every save.

  Two known gaps: symbol libraries (`.kicad_sym`) and footprint files
  (`.kicad_mod`) are still restamped unconditionally, and the token table
  can only warn about grammar changes it has an entry for.

## macOS

```
python3 packaging/macos/package_macos.py build dist
```

Copies `build/kicad/KiCad.app`, bundles the whole Homebrew dylib closure
into `Contents/Frameworks`, rewrites install names to `@executable_path`,
ad-hoc re-signs, rebrands the bundle, and produces
`dist/KiCad-Collaborative-<version>-macos.dmg`. The result runs on a
machine without Homebrew (verified: `DYLD_PRINT_LIBRARIES` shows zero
`/opt/homebrew` loads). The build is ad-hoc signed, not notarized:
first launch needs right-click → Open.

## Windows

Built in CI: the `windows-installer` GitHub Actions workflow builds the
tree under MSYS2/MINGW64, bundles the MinGW runtime DLL closure, and runs
NSIS on `packaging/windows/installer.nsi` to produce
`KiCad-Collaborative-<version>-windows-x64.exe` as a workflow artifact.
Trigger it from the Actions tab (workflow_dispatch) or by pushing a `v*`
tag. The workflow refuses to build against a libcurl without WebSocket
support, since the collaboration client would silently fail to connect.

Symbol/footprint libraries are not bundled on either platform; point the
library tables at an existing KiCad installation's libraries on first run.
