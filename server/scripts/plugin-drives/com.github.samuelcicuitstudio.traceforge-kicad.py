# board: demos/ecc83/ecc83-pp.kicad_pcb
"""TraceForge keeps a helper inside the board editor and opens its panel as a second program that talks to the helper
over a local port.  Expect the panel to open, its export to list the board's nets, and "Rotate selected items" to turn
the selected footprint on the board as one change.  The panel's log must hold no failed helper call for these."""
from pathlib import Path
import wx
import pcbnew
from drive_util import windows, label_of, find_all, messages

ran = {}


def modal(dlg):
    return wx.ID_CANCEL


def press(name):
    button = next((b for b in find_all(wx.Button) if label_of(b) == name and b.IsEnabled()), None)
    assert button is not None, "the panel has no '%s' button" % name
    event = wx.CommandEvent(wx.EVT_BUTTON.typeId, button.GetId())
    event.SetEventObject(button)
    button.GetEventHandler().ProcessEvent(event)


def after_run(action):
    panels = [w for w in windows() if type(w).__name__ == "TraceForgePanel"]
    if not panels and "first" not in ran:
        # the very first launch only sets up its net highlight shortcut and asks to be opened again, as on the desktop
        ran["first"] = [m for m in messages() if "open TraceForge again" in str(m)]
        assert ran["first"], "the first launch neither opened the panel nor asked to be opened again: %s" % messages()[-3:]
        return {"first_launch": "asked to be opened again after setting its shortcut"}
    assert panels, "the TraceForge panel did not open: %s" % [type(w).__name__ for w in windows()]
    if "once" in ran:
        return {"panel": label_of(panels[0])}
    ran["once"] = True
    log = Path.home() / "TraceForge" / "traceforge.log"
    start = log.stat().st_size if log.exists() else 0
    board = pcbnew.GetBoard()
    for item in list(board.GetCurrentSelection()):
        item.ClearSelected()

    press("Export paths")
    exported = sorted(Path("/project").glob("*.signal-paths.csv"))
    assert exported, "Export paths wrote no file"
    rows = [line for line in exported[0].read_text().splitlines() if line.strip()]
    assert len(rows) > 2, "the export lists no nets: %s" % rows[:3]

    part = max(board.GetFootprints(), key=lambda f: len(list(f.Pads())))
    reference, before = part.GetReference(), part.GetOrientationDegrees()
    part.SetSelected()
    press("Rotate selected items")
    after = pcbnew.GetBoard().FindFootprintByReference(reference).GetOrientationDegrees()
    said = log.read_text()[start:] if log.exists() else ""
    assert abs((after - before + 180) % 360 - 180) > 0.01, "%s was not rotated (%s): %s" % (reference, before, said[-400:])
    assert "Traceback" not in said, "the helper failed: %s" % said[-600:]
    return {"panel": label_of(panels[0]), "tabs": len(find_all(wx.Button)), "exported_rows": len(rows), "rotated": [reference, before, after]}
