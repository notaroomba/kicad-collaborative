"""Net Class Clearance Matrix: the table must show the project's net classes; type 0.3 mm between Default and USB_DIFF
and 0.25 mm between USB_DIFF and itself, press Update Custom Rules and read the project's custom rules file; then press
Remove From Custom Rules and read it again."""
# board: demos/royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb
import os
import wx
import wx.grid
from drive_util import windows, click, fire

DRU = "/project/RoyalBlue54L-Feather.kicad_dru"
seen = []


def modal(dlg):
    seen.append(" ".join(str(t.GetLabel()) for t in dlg.GetChildren() if isinstance(t, wx.StaticText)))
    return wx.ID_OK


def after_run(_action):
    wins = [w for w in windows() if type(w).__name__ == "NetClassClearanceMatrix"]
    assert wins, "the matrix window did not open: %s" % [type(w).__name__ for w in windows()]
    win = wins[0]
    g = win.gridNCCM
    classes = [g.GetColLabelValue(i) for i in range(g.GetNumberCols())]
    assert sorted(classes) == ["Default", "USB_DIFF"] and [g.GetRowLabelValue(i) for i in range(g.GetNumberRows())] == classes, classes
    d, u = classes.index("Default"), classes.index("USB_DIFF")
    pair = (d, u) if (d, u) in win.valid_coords else (u, d)
    g.SetCellValue(pair[0], pair[1], "0.3")
    g.SetCellValue(u, u, "0.25")
    fire(g, wx.grid.EVT_GRID_CELL_CHANGED)
    assert g.GetCellValue(pair[0], pair[1]) == "0.3 mm" and g.GetCellValue(u, u) == "0.25 mm", (g.GetCellValue(pair[0], pair[1]), g.GetCellValue(u, u))
    had = open(DRU).read() if os.path.exists(DRU) else None
    click("Update Custom Rules", win)
    text = open(DRU).read()
    assert "(version 1)" in text and text.count("(rule \"CLR_") == 2, text[-900:]
    cross = [b for b in text.split("(rule ")[1:] if "'Default'" in b and "'USB_DIFF'" in b]
    own = [b for b in text.split("(rule ")[1:] if b.count("'USB_DIFF'") == 2]
    assert len(cross) == 1 and "(constraint clearance (min 0.3mm))" in cross[0] and len(own) == 1 and "(constraint clearance (min 0.25mm))" in own[0], text[-900:]
    assert seen and ("created" in seen[-1] or "Updated" in seen[-1]), seen
    if had:
        assert all(line in text for line in had.splitlines() if line.strip() and "NCCM" not in line and "CLR_" not in line), "the rules the project already had are gone"
    click("Remove From Custom Rules", win)
    after = open(DRU).read()
    assert "CLR_" not in after and "(version 1)" in after and g.GetCellValue(u, u) == "", after[-400:]
    assert "Removed" in seen[-1], seen
    return {"classes": classes, "rules_written": 2, "said": seen}
