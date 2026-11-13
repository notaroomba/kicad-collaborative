# board: demos/complex_hierarchy/complex_hierarchy.kicad_pcb
# select: 00000000-0000-0000-0000-00005592d065
"""Replicate Layout: with Q201 of the first amplifier sheet selected, expect the window to list the other amplifier
sheet, pick it, press OK, and expect the second amplifier's parts arranged around Q301 exactly as the first
amplifier's are around Q201, with its tracks copied too.  Q304 is locked on this board and has to stay put."""
import math
import pcbnew
import wx

from drive_util import windows, messages


def _spread(board, anchor, hundred):
    a = board.FindFootprintByReference(anchor).GetPosition()
    out = {}
    for f in board.GetFootprints():
        ref = f.GetReference()
        digits = "".join(c for c in ref if c.isdigit())
        if len(digits) == 3 and digits[0] == hundred:
            p = f.GetPosition()
            out[ref.rstrip("0123456789") + digits[1:]] = math.hypot(p.x - a.x, p.y - a.y)
    return out


def modal(dlg):
    if type(dlg).__name__ == "DeprecationDialog":
        return wx.ID_OK
    return None


def after_run(_action):
    frame = [w for w in windows() if type(w).__name__ == "ReplicateLayoutDialog"]
    assert frame, "the Replicate Layout window never opened: %s" % messages()[-2:]
    frame = frame[0]
    board = pcbnew.GetBoard()
    levels = [frame.list_levels.GetString(i) for i in range(frame.list_levels.GetCount())]
    assert levels, "no hierarchy level is listed"
    sheets = [frame.list_sheets.GetString(i) for i in range(frame.list_sheets.GetCount())]
    assert len(sheets) == 1, "the sheets offered are %s (levels %s)" % (sheets, levels)
    source = _spread(board, "Q201", "2")
    before = _spread(board, "Q301", "3")
    differ = [k for k in source if k in before and abs(source[k] - before[k]) > 2000]
    differ = [k for k in differ if k != "Q04"]
    assert differ, "the two amplifiers are already laid out alike, the test would prove nothing"
    tracks = len(list(board.GetTracks()))
    frame.list_sheets.SetSelection(0)
    frame.on_ok(wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED, wx.ID_OK))
    said = messages()
    assert not any("rror" in m for m in said), "Replicate failed: %s" % said[-1][:600]
    after = _spread(pcbnew.GetBoard(), "Q301", "3")
    # Q304 is locked on this board and "Replicate locked footprints" is off: it must stay where it was.
    assert abs(after["Q04"] - before["Q04"]) <= 2000, "the locked Q304 was moved"
    off = [(k, round(source[k] / 1e6, 3), round(after[k] / 1e6, 3)) for k in source if k in after and k != "Q04" and abs(source[k] - after[k]) > 2000]
    assert not off, "%d of %d parts are not where the first amplifier has them: %s" % (len(off), len(source), off[:5])
    assert len(list(pcbnew.GetBoard().GetTracks())) > tracks, "no track was copied to the second amplifier"
    return {"levels": levels, "sheets": sheets, "parts_checked": len([k for k in source if k in after]), "moved": len(differ),
            "tracks": [tracks, len(list(pcbnew.GetBoard().GetTracks()))]}
