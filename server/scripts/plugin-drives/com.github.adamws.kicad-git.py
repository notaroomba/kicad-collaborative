"""Git Plugin: one button that saves the board and opens git's commit window.  Here git stands for the project's
version history, so expect: git found and its version read, the project folder found as the repository, the board
saved, and exactly one request to open the Save Version dialog (no name given, so nothing is saved behind the
person's back).  No error window.  The dialog itself is worked in the browser test (plugins-python-real-ui.mjs)."""
import os
import kicad_web
import pcbnew

seen = {"calls": []}
_call = kicad_web._call


def _spy(method, *a, **k):
    if method.startswith("project."):
        seen["calls"].append((method, dict(a[0]) if a and a[0] else {}))
    return _call(method, *a, **k)


kicad_web._call = _spy


def modal(dlg):
    raise AssertionError(f"the plugin showed an error window: {type(dlg).__name__} {getattr(dlg, 'GetMessage', lambda: '')()}")


def after_run(action):
    from drive_util import messages
    assert not messages(), messages()
    saves = [c for c in seen["calls"] if c[0] == "project.saveVersion"]
    assert len(saves) == 1, seen["calls"]
    assert not saves[0][1].get("name"), f"a version was saved without asking: {saves[0][1]}"
    board = pcbnew.GetBoard().GetFileName()
    assert os.path.exists(board) and os.path.getsize(board) > 1000, "the board file was not saved before the commit window"
    import glob
    logs = glob.glob("/**/kicadgit.log", recursive=True)
    assert logs, f"the plugin's log was not written ({type(action).__name__})"
    lines = open(logs[0]).read()
    assert "git version 2." in lines and "Repository top directory: " + os.path.dirname(board) in lines, lines[-600:]
    return {"asked": "Save Version dialog", "repository": os.path.dirname(board), "git": [l.split(": ", 1)[1] for l in lines.splitlines() if "git version" in l][:1]}
