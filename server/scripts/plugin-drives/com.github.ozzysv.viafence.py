# select: d7a2ea41-4fea-4c56-89ef-27fec710c0ad
"""ViaFence: with one straight 14.6 mm track selected, pick the GND net, press OK with the window's own settings (0.6 mm vias, 0.25 mm gap)
and expect a row of new vias on both sides of that track, each exactly the gap away from the track's copper."""
import math
import pcbnew
import wx
from drive_util import choose, click, messages

seen = {}


def _vias():
    return [t for t in pcbnew.GetBoard().GetTracks() if isinstance(t, pcbnew.PCB_VIA)]


def modal(dlg):
    if type(dlg).__name__ == "ViaFenceDialog" and "before" not in seen:
        seen["before"] = {v.m_Uuid.AsString() for v in _vias()}
        choose(dlg.net_choice, "GND")
        click("OK", dlg)
        return dlg.GetReturnCode() or wx.ID_CANCEL
    return wx.ID_OK


def after_run(_action):
    assert "before" in seen, "the ViaFence window never opened: %s" % messages()[-2:]
    new = [v for v in _vias() if v.m_Uuid.AsString() not in seen["before"]]
    assert len(new) >= 6, "only %d vias were added; the plugin said: %s" % (len(new), messages()[-2:])
    x, y1, y2, half = 156.21, 95.885, 110.5, 0.4          # the selected track: vertical, 0.8 mm wide
    sides, wrong = set(), []
    for v in new:
        px, py = pcbnew.ToMM(v.GetPosition().x), pcbnew.ToMM(v.GetPosition().y)
        d = math.hypot(px - x, py - min(max(py, y1), y2))
        gap = d - half - pcbnew.ToMM(v.GetWidth(pcbnew.F_Cu)) / 2
        sides.add(px > x)
        if abs(gap - 0.25) > 0.02:
            wrong.append((round(px, 3), round(py, 3), round(gap, 3)))
    assert not wrong, "%d of %d vias are not 0.25 mm from the track: %s" % (len(wrong), len(new), wrong[:4])
    assert all(v.GetNetname() == "GND" for v in new), "the vias are not on GND: %s" % sorted({v.GetNetname() for v in new})
    assert sides == {True, False}, "the vias are on one side of the track only"
    return {"vias": len(new), "said": [m[:160] for m in messages()[-1:]]}
