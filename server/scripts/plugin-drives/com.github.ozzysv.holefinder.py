"""HoleFinder: expect its count of drilled objects to match the board (every pad with a drill, every via), pick the first
hole of the first size, press Locate, and expect that pad or via to end up selected with its position in the status line."""
import re
import pcbnew
import wx
from drive_util import windows, click, find_all


def after_run(_action):
    frame = [w for w in windows() if type(w).__name__ == "HoleFinderFrame"]
    assert frame, "the HoleFinder window never opened"
    frame = frame[0]
    board = pcbnew.GetBoard()
    drilled = [p for p in board.GetPads() if p.GetDrillSize().x > 0 and p.GetDrillSize().y > 0]
    vias = [t for t in board.GetTracks() if isinstance(t, pcbnew.PCB_VIA)]
    said = " ".join(t.GetLabel() for t in find_all(wx.StaticText, root=frame))
    m = re.search(r"(\d+) drilled objects / (\d+) sizes", said)
    assert m, "no count in the window: %s" % said[:200]
    assert int(m.group(1)) == len(drilled) + len(vias), "it counts %s drilled objects, the board has %d pads with a drill and %d vias" % (m.group(1), len(drilled), len(vias))
    sizes = {(p.GetDrillSize().x, p.GetDrillSize().y) for p in drilled} | {(v.GetDrill(), v.GetDrill()) for v in vias}
    assert int(m.group(2)) == len(sizes), "it lists %s sizes, the board has %d" % (m.group(2), len(sizes))
    assert frame.listbox.GetCount() > 0, "the list of holes is empty"
    first = frame.listbox.GetString(0)
    frame.listbox.SetSelection(0)
    click("Locate", frame)
    wx._run_later()
    status = frame.status.GetLabel()
    assert first in status and "X=" in status, "Locate did not report the hole: %s" % status
    picked = [p for p in board.GetPads() if p.IsSelected()] + [v for v in vias if v.IsSelected()]
    assert len(picked) == 1, "Locate left %d items selected, not one" % len(picked)
    at = picked[0].GetPosition()
    want = "X=%s mm" % ("%.4f" % pcbnew.ToMM(at.x)).rstrip("0").rstrip(".")
    assert want in status, "the selected item is at %s, the window says: %s" % (want, status)
    return {"drilled": int(m.group(1)), "sizes": int(m.group(2)), "located": status.strip()}
