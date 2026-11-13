# board: demos/interf_u/interf_u.kicad_pcb
# select: b045eba5-4ff2-4c1e-9767-c5a3d906beb4,3eb69c08-3da0-4adb-89e2-0c584b72639b
# file: demos/interf_u/interf_u.kicad_sch
"""Swap Stubs: with pads 2 and 4 of JP1 selected (nets REF10 and REF11), expect the two pads to trade nets on the
board, and the two labels at JP1's pins to trade places in the schematic, which the plugin rewrites as a file and
the project then takes over."""
import re
import pcbnew
import wx

import kicad_web
from drive_util import messages

SCH = "interf_u.kicad_sch"


def _labels(text):
    return {name: (float(x), float(y)) for name, x, y in re.findall(r'\(label\s+"(REF1[01])"\s*\(at\s+([-\d.]+)\s+([-\d.]+)', text)}


def modal(dlg):
    if type(dlg).__name__ == "DeprecationDialog":
        return wx.ID_OK
    return None


def after_run(_action):
    assert not messages(), "the plugin said: %s" % messages()[-1][:500]
    jp1 = pcbnew.GetBoard().FindFootprintByReference("JP1")
    nets = {p.GetNumber(): p.GetNetname() for p in jp1.Pads() if p.GetNumber() in ("2", "4")}
    assert nets == {"2": "/REF11", "4": "/REF10"}, "the pads' nets are %s" % nets
    before = _labels(open("/kicad/drive/files/" + SCH, encoding="utf-8").read())
    after = _labels(open("/project/" + SCH, encoding="utf-8").read())
    assert len(before) == 2 and before["REF10"] != before["REF11"], before
    assert after == {"REF10": before["REF11"], "REF11": before["REF10"]}, "the labels are at %s, were at %s" % (after, before)
    kept = kicad_web._state["given_text"].get(SCH, "")
    assert _labels(kept) == after, "the project did not take the rewritten schematic"
    return {"pads": nets, "labels": after}
