"""PosOrient: expect its table to list every footprint with its position, mark the first row, type a new position and
angle into it, press Orient, and expect that footprint there, measured from the board's drill/place origin."""
import pcbnew
import wx
from drive_util import windows, find_all, label_of


def after_run(_action):
    dlg = [w for w in windows() if type(w).__name__ == "PosOrientDialog"]
    assert dlg, "the PosOrient window never opened"
    dlg = dlg[0]
    board = pcbnew.GetBoard()
    grid = dlg.grid
    fps = list(board.GetFootprints())
    assert grid.GetNumberRows() == len(fps), "the table has %d rows for %d footprints" % (grid.GetNumberRows(), len(fps))
    origin = board.GetDesignSettings().GetAuxOrigin()
    ref = grid.GetCellValue(0, 1)
    fp = board.FindFootprintByReference(ref)
    assert fp is not None, "the table's first row names “%s”, which is not on the board" % ref
    listed = (float(grid.GetCellValue(0, 3)), float(grid.GetCellValue(0, 4)))
    real = ((fp.GetPosition().x - origin.x) / 1e6, (fp.GetPosition().y - origin.y) / 1e6)
    assert abs(listed[0] - real[0]) < 1e-6 and abs(listed[1] - real[1]) < 1e-6, "%s is listed at %s, it is at %s" % (ref, listed, real)
    grid.SetCellValue(0, 0, "1")
    grid.SetCellValue(0, 3, "51.5")
    grid.SetCellValue(0, 4, "62.25")
    grid.SetCellValue(0, 5, "90")
    orient = [b for b in find_all(wx.Button, root=dlg) if label_of(b) == "Orient"]
    assert orient, "the window has no Orient button"
    orient[0]._wx_clicked()
    fp = pcbnew.GetBoard().FindFootprintByReference(ref)
    got = (round((fp.GetPosition().x - origin.x) / 1e6, 4), round((fp.GetPosition().y - origin.y) / 1e6, 4), round(fp.GetOrientationDegrees() % 360, 3))
    assert got == (51.5, 62.25, 90.0), "%s ended at %s, the table asked for (51.5, 62.25, 90): %s" % (ref, got, dlg.log.GetValue()[-200:])
    return {"rows": len(fps), "moved": ref, "to": got}
