"""Gerber Zipper 2: press "Make Gerber and ZIP" with the first manufacturer and expect its step-by-step run to finish:
Gerbers and drill files made by kicad-cli, the ZIP written with them inside, and BOM and position files beside it."""
import os
import zipfile
import wx
from drive_util import click

seen = {}


def modal(dlg):
    kind = type(dlg).__name__
    if kind == "ExecDialog":                      # the run's own log window: it steps through the work, then offers Close
        seen["log"] = dlg.text.GetValue()
        return wx.ID_OK
    if kind == "CustomMessageDialog":             # "… error, continue?": go on, the log says what failed
        seen.setdefault("asked", []).append(" ".join(str(t.GetLabel()) for t in dlg.GetChildren() if isinstance(t, wx.StaticText))[:200])
        return wx.ID_OK
    if "ran" not in seen:
        seen["ran"] = True
        click("Make Gerber and ZIP", dlg)
    return wx.ID_CANCEL


def after_run(_action):
    log = seen.get("log", "")
    assert "Output Complete" in log, "the run did not finish: %s" % log[-500:]
    out = "/project/Gerber"
    zips = [f for f in os.listdir(out) if f.upper().endswith(".ZIP")]
    assert zips, "no ZIP was written: %s" % sorted(os.listdir(out))
    with zipfile.ZipFile(os.path.join(out, zips[0])) as z:
        names = z.namelist()
        sizes = [i.file_size for i in z.infolist()]
    # the files' contents come from the editor's own Gerber and drill writers; this headless run has a stand-in editor
    # that hands back placeholders, so only the browser run can check what is in them
    assert len(names) >= 6 and min(sizes) > 0, "the ZIP is not a set of Gerbers: %s" % list(zip(names, sizes))
    assert any(n.upper().endswith(".GTL") for n in names) and any(n.upper().endswith(".TXT") for n in names), names
    assert any("BOM" in f for f in os.listdir(out)) and any("POS" in f for f in os.listdir(out)), sorted(os.listdir(out))
    return {"zip": zips[0], "in_zip": len(names), "smallest": min(sizes), "asked": seen.get("asked", [])[:3]}
