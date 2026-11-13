"""Gerber Zipper 2: press "Make Gerber and ZIP" with the first manufacturer and expect its step-by-step run to finish:
Gerbers and drill files made by kicad-cli, the ZIP written with them inside, and BOM and position files beside it."""
# board: demos/royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb
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
        text = {n: z.read(n).decode("utf-8", "replace") for n in names}
    # the Gerbers and drill files are the editor's own writers' work (the board keeps KiCad's standard layer names; a board
    # that renames its copper layers gets files named after them, in KiCad too, and the plugin does not find those)
    top = [n for n in names if n.upper().endswith(".GTL")]
    assert top and any(n.upper().endswith(".GBL") for n in names) and any(n.upper().endswith(".GML") or n.upper().endswith(".GKO") or n.upper().endswith(".GM1") for n in names), names
    g = text[top[0]]
    assert "%FSLAX" in g and "%ADD" in g and g.count("D03*") > 100 and g.count("D01*") > 100 and g.rstrip().endswith("M02*"), g[:300]
    drl = [n for n in names if n.upper().endswith(".TXT") or n.upper().endswith(".DRL") or n.upper().endswith(".XLN")]
    assert drl, names
    d = text[drl[0]]
    assert d.startswith("M48") and "T1C" in d and d.count("\nX") > 20 and d.rstrip().endswith("M30"), d[:300]
    assert any("BOM" in f for f in os.listdir(out)) and any("POS" in f for f in os.listdir(out)), sorted(os.listdir(out))
    return {"zip": zips[0], "in_zip": len(names), "top_copper_flashes": g.count("D03*"), "holes": d.count("\nX"), "asked": seen.get("asked", [])[:3]}
