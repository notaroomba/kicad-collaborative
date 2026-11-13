# board: demos/complex_hierarchy/complex_hierarchy.kicad_pcb
"""Layout Clone: select the first amplifier's 29 parts and press 1 (capture source), select the second amplifier's and
press 2 (capture target), press 3 (match and preview), take the plugin's suggestion for parts it cannot tell apart, and
press 4 (apply). Expect every part of the second amplifier as far from its anchor U301 as its twin is from U201.
Q304 is locked on this board and the plugin rightly refuses to move it, so the test unlocks it first, as it asks."""
import math
import pcbnew
import wx
from drive_util import windows, click, find_all, label_of, messages


def _pick(hundred):
    for f in pcbnew.GetBoard().GetFootprints():
        digits = "".join(c for c in f.GetReference() if c.isdigit())
        if len(digits) == 3 and digits[0] == hundred:
            f.SetSelected()
        else:
            f.ClearSelected()


def _spread(anchor, hundred):
    board = pcbnew.GetBoard()
    a = board.FindFootprintByReference(anchor).GetPosition()
    out = {}
    for f in board.GetFootprints():
        ref = f.GetReference()
        digits = "".join(c for c in ref if c.isdigit())
        if len(digits) == 3 and digits[0] == hundred:
            p = f.GetPosition()
            out[ref] = math.hypot(p.x - a.x, p.y - a.y)
    return out


def after_run(_action):
    wx._run_later()
    frame = [w for w in windows() if type(w).__name__ == "MainFrame"]
    assert frame, "the Layout Clone window never opened: %s" % messages()[-2:]
    frame = frame[0]
    status = lambda: frame.status.GetStatusText()
    pcbnew.GetBoard().FindFootprintByReference("Q304").SetLocked(False)
    pcbnew.Refresh()
    before = _spread("U301", "3")
    _pick("2")
    click("1 ·", frame)
    wx._run_later()
    assert "29" in status() and frame.source_anchor.GetValue() == "U201", "capturing the source said: %s" % status()
    _pick("3")
    click("2 ·", frame)
    wx._run_later()
    assert len(frame.targets) == 1 and frame.targets[0].anchor == "U301", "capturing the target said: %s" % status()
    click("3 ·", frame)
    wx._run_later()
    assert frame.pages, "no preview came: %s" % status()
    page = frame.pages[0]
    if page.poses is None:                      # parts it cannot tell apart electrically: take its suggestion
        take = [b for b in find_all(wx.Button, root=frame) if "suggestion" in label_of(b) and b.IsEnabled()]
        assert take, "the preview is incomplete and offers no suggestion: %s" % page.note_text
        take[0]._wx_clicked()
        wx._run_later()
    assert page.poses is not None and frame.apply_button.IsEnabled(), "the preview is not ready to apply: %s / %s" % (page.note_text, status())
    mapping = dict(page.mapping())
    frame.apply_button._wx_clicked()
    wx._run_later()
    source, after = _spread("U201", "2"), _spread("U301", "3")
    off = [(s, t, round(source[s] / 1e6, 3), round(after[t] / 1e6, 3)) for s, t in mapping.items() if abs(source[s] - after[t]) > 2000]
    assert not off, "%d of %d parts are not where their twin is: %s; the plugin said: %s" % (len(off), len(mapping), off[:4], status())
    moved = [t for t in after if abs(after[t] - before[t]) > 2000]
    assert len(moved) >= 20, "only %d parts moved: the two amplifiers were already alike" % len(moved)
    return {"matched": len(mapping), "moved": len(moved), "said": status()}
