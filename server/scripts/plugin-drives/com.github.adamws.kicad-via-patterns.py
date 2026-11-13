# board: demos/kit-dev-coldfire-xilinx_5213/kit-dev-coldfire-xilinx_5213.kicad_pcb
# select: 5933d281-99eb-4979-bcd3-a1622ea44da4
"""Via Patterns: with one via selected, accept the window's own settings and expect the pattern's vias on the board,
all on the selected via's size and drill; then turn the pattern once with the rotate window."""
import pcbnew
import wx
from drive_util import find_all, label_of

seen = {}


def _vias():
    return [t for t in pcbnew.GetBoard().GetTracks() if isinstance(t, pcbnew.PCB_VIA)]


def modal(dlg):
    kind = type(dlg).__name__
    if kind == "SelectViaDialog":
        seen["asked_for_via"] = True
        return wx.ID_CANCEL
    if kind == "MainDialog":
        seen["before"] = len(_vias())
        seen["count"] = dlg.get_number_of_vias()
        seen["pattern"] = str(dlg.get_pattern_type())
        ok = [b for b in find_all(wx.Button, root=dlg) if b.GetId() == wx.ID_OK]
        assert ok, "the window has no OK button"
        ok[0]._wx_clicked()
        return dlg.GetReturnCode() or wx.ID_CANCEL
    if kind == "RotateDialog":
        seen["after_add"] = len(_vias())
        seen["spots"] = sorted((v.GetPosition().x, v.GetPosition().y) for v in _vias())
        buttons = [b for b in find_all(wx.Button, root=dlg) if b.IsEnabled()]
        seen["rotate_buttons"] = [label_of(b) for b in buttons]
        if buttons:
            buttons[0]._wx_clicked()
        seen["moved"] = sorted((v.GetPosition().x, v.GetPosition().y) for v in _vias()) != seen["spots"]
        return wx.ID_CANCEL
    return wx.ID_CANCEL


def after_run(_action):
    assert not seen.get("asked_for_via"), "the plugin did not see the selected via"
    assert "before" in seen, "the Via Patterns window never opened"
    assert "after_add" in seen, "no pattern was added, so the rotate window never came"
    added = seen["after_add"] - seen["before"]
    assert added >= 1, "no via was added (%d before, %d after)" % (seen["before"], seen["after_add"])
    assert seen["moved"], "the rotate button did not move the pattern (buttons: %s)" % seen["rotate_buttons"]
    return {"asked_for": seen["count"], "pattern": seen["pattern"], "vias_added": added, "rotated": seen["moved"]}
