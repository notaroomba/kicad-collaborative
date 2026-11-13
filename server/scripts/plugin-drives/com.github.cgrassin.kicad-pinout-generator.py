# select: 00000000-0000-0000-0000-00005a334ccc
"""Pinout Generator: with the valve U1 selected, expect the result window to list each of its connected pads with its net,
then switch the format to CSV and Markdown and expect the same pins in those forms."""
import pcbnew
import wx
from drive_util import choose

seen = {}


def modal(dlg):
    if type(dlg).__name__ != "PinoutDialog":
        return wx.ID_OK
    seen["list"] = dlg.result.GetValue()
    choose(dlg.output_format, "CSV")
    seen["csv"] = dlg.result.GetValue()
    choose(dlg.output_format, "Markdown table")
    seen["md"] = dlg.result.GetValue()
    return wx.ID_OK


def after_run(_action):
    assert "list" in seen, "the Pinout result window never opened"
    u1 = pcbnew.GetBoard().FindFootprintByReference("U1")
    pads, numbers = [], set()
    for p in u1.Pads():                      # one line per pad number, a pad without a net reads NC, as the plugin documents
        if str(p.GetNumber()) and str(p.GetNumber()) not in numbers:
            numbers.add(str(p.GetNumber()))
            pads.append((str(p.GetNumber()), p.GetNetname().lstrip("/") or "NC"))
    assert len(pads) >= 6, "U1 has too few pads to test with"
    lines = [l.split("\t") for l in seen["list"].splitlines() if l.strip()]
    got = sorted((l[0], l[-1]) for l in lines)
    assert got == sorted(pads), "the list shows %s, U1's pads are %s" % (got[:4], sorted(pads)[:4])
    for kind in ("csv", "md"):
        missing = [n for _, n in pads if n not in seen[kind]]
        assert not missing and seen[kind] != seen["list"], "the %s output lacks %s:\n%s" % (kind, missing[:3], seen[kind][:300])
    assert seen["md"].count("|") >= 3 * len(pads), "the Markdown output is not a table:\n%s" % seen["md"][:300]
    return {"pins": len(pads), "first": lines[0]}
