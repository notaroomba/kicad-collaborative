# board: demos/kit-dev-coldfire-xilinx_5213/kit-dev-coldfire-xilinx_5213.kicad_pcb
"""Z2 Via Colino: choose the ground net, compute the drafts (numpy), look at the picture of the chosen draft, place it,
and expect the new stitching vias on the board, in the plugin's group."""
import wx
import pcbnew
from drive_util import find, find_all, click, messages

seen = {}


def modal(dlg):
    if "Via Colino" not in dlg.GetTitle() or seen:
        return None
    net = find(wx.Choice, root=dlg)
    choices = [c for c in find_all(wx.Choice, root=dlg)]
    net = next(c for c in choices if c.GetCount() > 2)
    names = [net.GetString(i) for i in range(net.GetCount())]
    gnd = next((n for n in names if n.upper() in ("GND", "/GND")), names[0])
    net.SetStringSelection(gnd)
    before = sum(1 for t in pcbnew.GetBoard().GetTracks() if t.Type() == pcbnew.PCB_VIA_T)
    click("1. Compute drafts", dlg)
    lst = find_all(wx.ListCtrl, root=dlg)[0]
    drafts = lst.GetItemCount()
    assert drafts > 0, "no draft was computed: %s" % messages()[-2:]
    picture = find(wx.StaticBitmap, root=dlg)
    url = str(picture.el.src or "")
    assert url.startswith("data:image/png;base64,") and len(url) > 2000, "the draft's picture is not shown"
    row = [lst.GetItemText(drafts - 1, c) for c in range(5)]
    click("2. Place selected draft", dlg)
    after = sum(1 for t in pcbnew.GetBoard().GetTracks() if t.Type() == pcbnew.PCB_VIA_T)
    seen.update(net=gnd, drafts=drafts, chosen=row, placed=after - before, said=[m[:160] for m in messages()[-2:]])
    return wx.ID_CLOSE


def after_run(_action):
    assert seen, "the plugin's dialog did not open"
    assert seen["placed"] > 0, "no via was placed: %s" % seen["said"]
    return seen
