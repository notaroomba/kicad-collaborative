"""PCB Coil Creator: press "Generate Coil" with the values the window opens with and expect a coil footprint on the board.
The plugin puts the footprint on the clipboard and presses Ctrl+V in the editor, as it does in KiCad."""
import pcbnew
import wx
from drive_util import click

seen = {}


def _press(dlg=None):
    seen["ran"] = True
    seen["before"] = len(list(pcbnew.GetBoard().GetFootprints()))
    click("Generate Coil", dlg)


def modal(dlg):
    if "ran" not in seen:
        _press(dlg)
    return wx.ID_CANCEL


def after_run(_action):
    if "ran" not in seen:                 # a window that stays open beside the editor
        _press()
        wx._run_later()
    before = seen["before"]
    seen.clear()                          # each of the plugin's commands is checked on its own
    fps = list(pcbnew.GetBoard().GetFootprints())
    assert len(fps) == before + 1, "no coil landed on the board (%d footprints before, %d after)" % (before, len(fps))
    coil = fps[-1]
    pads = len(list(coil.Pads()))
    shapes = len(list(coil.GraphicalItems()))
    assert pads >= 2 and shapes >= 4, "the new footprint is not a coil: %d pads, %d shapes" % (pads, shapes)
    return {"pads": pads, "shapes": shapes, "name": str(coil.GetFPID().GetLibItemName())}
