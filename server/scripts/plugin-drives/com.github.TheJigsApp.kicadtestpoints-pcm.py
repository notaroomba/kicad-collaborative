"""Testpoint Report: mark three pads as test points (the pad property the plugin reads), press Submit, and expect its CSV
to list exactly those pads with their nets and positions."""
import csv
import os
import pcbnew
import wx
from drive_util import click

seen = {}


def modal(dlg):
    if type(dlg).__name__ == "MyDialog" and "ran" not in seen:
        seen["ran"] = True
        pads = [p for p in pcbnew.GetBoard().GetPads() if p.GetNetname()][:3]
        for p in pads:
            p.SetProperty(pcbnew.PAD_PROP_TESTPOINT)
        seen["pads"] = sorted((p.GetParentFootprint().GetReference(), str(p.GetNumber()), p.GetNetname()) for p in pads)
        click("Submit", dlg)
        return dlg.GetReturnCode() or wx.ID_CANCEL
    return wx.ID_OK


def after_run(_action):
    assert seen.get("ran"), "the Testpoint Report window never opened"
    assert len(seen["pads"]) == 3, "the test board has too few pads on nets"
    path = "/project/ecc83-pp-testpoints.csv"
    found = [f for f in os.listdir("/project") if f.endswith("-testpoints.csv")]
    assert found, "no CSV was written: %s" % sorted(os.listdir("/project"))
    with open(os.path.join("/project", found[0]), newline="") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 3, "the CSV has %d rows for 3 test points: %s" % (len(rows), rows[:4])
    nets = sorted(r.get("net", "") for r in rows)
    assert nets == sorted(p[2] for p in seen["pads"]), "the CSV's nets %s are not the marked pads' nets %s" % (nets, seen["pads"])
    return {"rows": len(rows), "columns": list(rows[0].keys())}
