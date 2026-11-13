"""kicad_harness: drive KiCad schematics and boards with plain Python calls.

    import kicad_harness as kh
    with kh.open("my_board/") as project:          # KiCad files in a folder
        sch = project.schematic()
        sch.place("Device:R", ref="R1", value="10k")
        sch.connect("U1.3", "R1.1")
        board = project.board()
        board.sync(); board.autoplace(); board.route()

    project = kh.connect("https://kicad.example", token, "my project")   # a live online project

The same calls work on local files, on an online project (edits reach everyone in the
document) and inside the MCP server's run_python tool.  Parts are made from datasheets with
`kicad_harness.parts`.
"""
from __future__ import annotations

import glob as _glob
import io as _io
import os as _os

from .project import Board, Pin, Project, Schematic
from .transport import HarnessError, HostTransport, LocalEngine, McpTransport
from . import rules as _rules

_rules.install(Project, Schematic, Board)

__all__ = ["open", "connect", "current", "Project", "Schematic", "Board", "Pin", "HarnessError", "parts"]
__version__ = "0.1.0"


def open(path: str, libs: list | None = None, server: str | None = None, token: str | None = None) -> Project:   # noqa: A001
    """Open the KiCad project in a folder (or the project one of its files belongs to)."""
    path = _os.path.abspath(path)
    folder = path if _os.path.isdir(path) else _os.path.dirname(path)
    stem = None if _os.path.isdir(path) else _os.path.splitext(_os.path.basename(path))[0]
    files = sorted(f for ext in ("kicad_sch", "kicad_pcb", "kicad_pro") for f in _glob.glob(_os.path.join(folder, "*." + ext)))
    if not files:
        raise HarnessError(f"There are no KiCad files in {folder}.")
    pro = [f for f in files if f.endswith(".kicad_pro")]
    name = stem or (_os.path.splitext(_os.path.basename(pro[0]))[0] if pro else _os.path.basename(folder))
    # the root sheet (named like the project) first, so it is the default schematic
    files.sort(key=lambda f: (0 if _os.path.splitext(_os.path.basename(f))[0] == name else 1, f))
    return Project(LocalEngine(files, name=name, libs=libs, server=server, token=token))


def new(folder: str, name: str | None = None) -> Project:
    """Start an empty project (schematic, board and project file) in a folder and open it."""
    import uuid
    _os.makedirs(folder, exist_ok=True)
    name = name or _os.path.basename(_os.path.abspath(folder))
    base = _os.path.join(folder, name)
    if not _os.path.exists(base + ".kicad_sch"):
        with _io.open(base + ".kicad_sch", "w") as f:
            f.write(f'(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "{uuid.uuid4()}") (paper "A3") (lib_symbols) (sheet_instances (path "/" (page "1"))))\n')
    if not _os.path.exists(base + ".kicad_pcb"):
        with _io.open(base + ".kicad_pcb", "w") as f:
            f.write('(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0") (general (thickness 1.6)) (paper "A4") '
                    '(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes" user "F.Adhesive") (11 "B.Adhes" user "B.Adhesive") (13 "F.Paste" user) (15 "B.Paste" user) '
                    '(5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (17 "Dwgs.User" user "User.Drawings") '
                    '(19 "Cmts.User" user "User.Comments") (25 "Edge.Cuts" user) (27 "Margin" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard") '
                    '(35 "F.Fab" user) (33 "B.Fab" user)) (setup (pad_to_mask_clearance 0)) (net 0 ""))\n')
    if not _os.path.exists(base + ".kicad_pro"):
        with _io.open(base + ".kicad_pro", "w") as f:
            f.write('{\n  "meta": { "filename": "%s.kicad_pro", "version": 3 },\n  "net_settings": { "classes": [], "meta": { "version": 4 } },\n  "board": { "design_settings": { "rules": {} } }\n}\n' % name)
    return open(folder)


def connect(url: str, token: str, project: str, live: bool = True) -> Project:
    """Open an online project on a Junction server; edits are live for everyone in it.

    With `live` (the default) each batch of edits is drawn a few items at a time with a cursor on them.
    """
    return Project(McpTransport(url, token, project, live=live))


_current: Project | None = None


def current() -> Project:
    """The project a run_python call was made for (inside the server's run_python tool)."""
    global _current
    if _current is None:
        _current = Project(HostTransport())
    return _current


from . import parts  # noqa: E402
