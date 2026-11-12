# board: demos/ecc83/ecc83-pp.kicad_pcb
"""Tracklayer autoroute: in its dialog tick "pull up the existing tracks first" (the demo board is already routed), press
Route, and expect the router (numpy) to put new tracks on the board as one change and say how many."""
import re
import wx
from drive_util import find, click

seen = {}


def modal(dlg):
    if "Tracklayer" not in dlg.GetTitle() or seen:
        return None
    find(wx.CheckBox, "Pull up the existing tracks", dlg).SetValue(True)
    click("Route", dlg)
    log = dlg.log.GetValue()
    seen["log"] = [line for line in log.splitlines() if line.strip()][-14:]
    m = re.search(r"Added (\d+) items", log)
    seen["added"] = int(m.group(1)) if m else 0
    m = re.search(r"(\d+) pads, (\d+) nets to route", log)
    seen["nets"] = int(m.group(2)) if m else 0
    seen["left"] = next((line for line in log.splitlines() if line.startswith("Left for hand routing")), "")
    seen["failed"] = "Failed" in log
    return wx.ID_CANCEL


def after_run(_action):
    assert seen, "the plugin's dialog did not open"
    assert not seen["failed"], "the router failed: %s" % seen["log"][-6:]
    assert seen["added"] > 0, "no track was added: %s" % seen["log"][-6:]
    return {"nets": seen["nets"], "added": seen["added"], "left": seen["left"][:200], "log": seen["log"][-4:]}
