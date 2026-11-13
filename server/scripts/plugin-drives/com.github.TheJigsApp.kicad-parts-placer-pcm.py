"""Parts Placer: give it a spreadsheet that places two parts (one turned by 90 degrees), press Submit, and expect both parts
at the spreadsheet's positions, measured from the board's drill/place origin with Y pointing up as the plugin documents."""
import pcbnew
import wx
from drive_util import click, find, messages

seen = {}


def modal(dlg):
    if type(dlg).__name__ != "MyDialog" or "ran" in seen:
        return wx.ID_OK
    seen["ran"] = True
    board = pcbnew.GetBoard()
    refs = [f.GetReference() for f in board.GetFootprints() if not f.IsLocked()][:2]
    seen["rows"] = [(refs[0], 12.5, -20.0, 90.0), (refs[1], 30.0, -41.25, 0.0)]
    with open("/project/placement.csv", "w") as f:
        f.write("Ref Des, X, Y, Rotation\n")
        for r in seen["rows"]:
            f.write("%s, %s, %s, %s\n" % r)
    picker = find(wx.FilePickerCtrl, root=dlg)
    picker.SetPath("/project/placement.csv")
    picker._wx_changed()
    origin = board.GetDesignSettings().GetAuxOrigin()
    seen["origin"] = (pcbnew.ToMM(origin.x), pcbnew.ToMM(origin.y))
    click("Submit", dlg)
    return dlg.GetReturnCode() or wx.ID_CANCEL


def after_run(_action):
    assert seen.get("ran"), "the Parts Placer window never opened"
    board = pcbnew.GetBoard()
    ox, oy = seen["origin"]
    out = {}
    for ref, x, y, rot in seen["rows"]:
        fp = board.FindFootprintByReference(ref)
        at = fp.GetPosition()
        got = (round(pcbnew.ToMM(at.x), 4), round(pcbnew.ToMM(at.y), 4), round(fp.GetOrientationDegrees() % 360, 3))
        want = (round(x + ox, 4), round(-y + oy, 4), rot)
        assert got == want, "%s is at %s, the spreadsheet asked for %s; the plugin said: %s" % (ref, got, want, messages()[-2:])
        out[ref] = got
    return out
