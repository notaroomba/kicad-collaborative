# board: demos/kit-dev-coldfire-xilinx_5213/kit-dev-coldfire-xilinx_5213.kicad_pcb
"""kicad-splitplane: tick two supply nets on an inner layer, press Apply, and expect one zone per net in the board."""
import wx
from drive_util import find, find_all, click, texts, messages


def after_run(_action):
    box = find(wx.CheckListBox)
    names = [box.GetString(i) for i in range(box.GetCount())]
    assert len(names) >= 2, "the plugin lists %d supply nets on this board" % len(names)
    for i in (0, 1):
        box.Check(i)
    layer = find(wx.Choice)
    inner = [layer.GetString(i) for i in range(layer.GetCount()) if layer.GetString(i).startswith("In")]
    layer.SetStringSelection(inner[-1])
    click("Apply")
    said = texts()
    status = [t for t in said if t.startswith(("Zones added", "Failed", "Warnings", "OK:"))]
    log = next((t for t in said if "added " in t and "zone(s)" in t), "")
    assert any(t.startswith("Zones added to the board") for t in said), "no zones were written: %s / %s" % (said[-6:], messages()[-3:])
    # the preview: a matplotlib figure, rendered to pixels and painted on the dialog's canvas
    drawn = [w for w in find_all(wx.Panel) if any(op[0] == "img" for op in w.__dict__.get("_wx_last_ops", []))]
    assert drawn, "the preview was not painted"
    picture = next(op for op in drawn[0].__dict__["_wx_last_ops"] if op[0] == "img")
    assert picture[1].startswith("data:image/png;base64,") and len(picture[1]) > 3000, "the preview is not a picture"
    return {"preview": "%d×%d px, %d KB PNG" % (picture[4], picture[5], len(picture[1]) * 3 // 4 // 1024), "nets": names[:2], "layer": inner[-1], "status": status, "log": [l for l in log.splitlines() if "zone" in l][:6]}
