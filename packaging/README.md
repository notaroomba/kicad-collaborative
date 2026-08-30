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
- **File format:** files are saved in this fork's native format (KiCad
  10.99 development format, unchanged from upstream). A stock KiCad of the
  *same* version reads them as-is; an *older* stock KiCad (e.g. 9.0) will
  warn about a newer format, exactly as it would for files from an upstream
  10.99 nightly. True format downgrading on save is not supported —
  upstream KiCad has no such mechanism and new-format features cannot be
  expressed in old grammars.

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
