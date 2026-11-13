# board: demos/royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb
"""PCB to Fritzing Part: give it an output folder, leave the 3D picture out (this test's stand-in editor has no 3D viewer;
the browser has), press Generate, and expect a Fritzing part: the .fzpz archive with the part description and its
breadboard, schematic and PCB drawings, and a connector for each of the 28 pins of the board's two pin headers."""
import os
import zipfile
import xml.etree.ElementTree as ET
import wx
from drive_util import click, find_all, label_of, tick, messages

seen = {}


def modal(dlg):
    if type(dlg).__name__ != "PCBtoFritzingPartDialog" or "ran" in seen:
        return wx.ID_OK
    seen["ran"] = True
    os.makedirs("/project/fritzing", exist_ok=True)
    fields = find_all(wx.TextCtrl, root=dlg)
    fields[0].SetValue("/project/fritzing")
    for box in find_all(wx.CheckBox, root=dlg):
        if label_of(box).startswith("3D render"):
            tick(box, False)
    click("Generate", dlg)
    wx._run_later()
    seen["log"] = fields[-1].GetValue()
    return wx.ID_CANCEL


def after_run(_action):
    assert seen.get("ran"), "the PCB to Fritzing Part window never opened"
    log = seen["log"]
    assert "Export complete" in log and "ERROR" not in log, "the export did not finish cleanly:\n%s\n%s" % (log[-900:], messages()[-2:])
    out = "/project/fritzing"
    found = [f for f in os.listdir(out) if f.endswith(".fzpz")]
    assert found, "no .fzpz was written: %s" % sorted(os.listdir(out))
    part = os.path.join(out, found[0])
    with zipfile.ZipFile(part) as z:
        names = z.namelist()
        fzp = [n for n in names if n.endswith(".fzp")]
        svgs = [n for n in names if n.endswith(".svg")]
        assert fzp and len(svgs) >= 4, "the part archive holds %s" % names
        root = ET.fromstring(z.read(fzp[0]))
        for n in svgs:
            drawing = ET.fromstring(z.read(n))
            assert drawing.tag.endswith("svg") and len(list(drawing.iter())) > 1, "%s is not a drawing" % n
    connectors = root.findall(".//connector")
    assert root.tag == "module" and len(connectors) >= 28, "the part description has %d connectors for 28 header pins" % len(connectors)
    views = {v.tag for v in root.findall(".//views/*")}
    assert {"breadboardView", "schematicView", "pcbView"} <= views, "the part lacks a view: %s" % sorted(views)
    return {"in_archive": names, "connectors": len(connectors)}
