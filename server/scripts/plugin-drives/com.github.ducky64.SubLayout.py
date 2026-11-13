# board: demos/complex_hierarchy/complex_hierarchy.kicad_pcb
# select: 00000000-0000-0000-0000-00005592d065
"""SubLayout: with Q201 of the first amplifier sheet selected as anchor, expect the window to offer that sheet and both
of its instances, pick both, press Replicate, and expect the second amplifier's parts arranged around Q301 exactly as
the first amplifier's are around Q201."""
import math
import pcbnew
import wx
from drive_util import windows, click, fire, messages


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


def after_run(_action):
    frame = [w for w in windows() if type(w).__name__ == "SubLayoutFrame"]
    assert frame, "the SubLayout window never opened: %s" % messages()[-2:]
    frame = frame[0]
    board = pcbnew.GetBoard()
    levels = [frame._hierarchy_list.GetString(i) for i in range(frame._hierarchy_list.GetCount())]
    assert levels and "ampli_ht" in levels[0], "the hierarchy list does not show the amplifier sheet: %s" % levels
    names = [frame._instance_list.GetString(i) for i in range(frame._instance_list.GetCount())]
    assert len(names) == 2 and names[0].startswith("Q201") and names[1].startswith("Q301"), "the instances offered are %s; the plugin said: %s" % (names, [m[-700:] for m in messages()[-1:]])
    before = _spread(board, "Q301", "3")
    source = _spread(board, "Q201", "2")
    differ = [k for k in source if k in before and abs(source[k] - before[k]) > 2000]
    assert differ, "the two amplifiers are already laid out alike, the test would prove nothing"
    for i in range(2):
        frame._instance_list.SetSelection(i)
    fire(frame._instance_list, wx.EVT_LISTBOX)
    click("Replicate", frame)
    said = messages()
    assert not any("Error" in m for m in said), "Replicate failed: %s" % said[-1][:600]
    after = _spread(pcbnew.GetBoard(), "Q301", "3")
    off = [(k, round(source[k] / 1e6, 3), round(after[k] / 1e6, 3)) for k in source if k in after and abs(source[k] - after[k]) > 2000]
    assert not off, "%d of %d parts are not where the first amplifier has them: %s" % (len(off), len(source), off[:5])
    return {"levels": levels, "instances": names, "parts_checked": len([k for k in source if k in after]), "moved": len(differ)}
