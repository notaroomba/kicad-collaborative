"""SparkFun CAMmer: press Run CAMmer with the layers it ticks by default and open the zip it writes beside the board:
every chosen layer as a Gerber under the fab's extension, the outline, and one drill file with every hole of the board."""
# board: demos/stickhub/StickHub.kicad_pcb
import os
import zipfile
import wx
from drive_util import click, messages, gerber_drawn, holes_drilled

seen = {}


def modal(dlg):
    if "ran" not in seen:
        seen["ran"] = True
        click("Run CAMmer", dlg)
        return wx.ID_OK
    return wx.ID_CANCEL


def after_run(_action):
    said = messages()
    log = open("/project/cammer.log", encoding="utf-8", errors="replace").read() if os.path.exists("/project/cammer.log") else ""
    assert any("CAMmer complete" in m for m in said), (said, log[-600:])
    zips = [f for f in os.listdir("/project") if f.lower().endswith(".zip")]
    assert len(zips) == 1, sorted(os.listdir("/project"))
    with zipfile.ZipFile(os.path.join("/project", zips[0])) as z:
        text = {n: z.read(n).decode("utf-8", "replace") for n in z.namelist()}
    ext = {n.rsplit(".", 1)[1].upper(): t for n, t in text.items()}
    assert {"GTL", "GBL", "GTS", "GBS", "GTO", "GBO", "GTP", "GKO", "DRL"} <= set(ext), sorted(text)
    gerber_drawn(ext["GTL"], 100, 100)
    gerber_drawn(ext["GBL"], 20, 20)
    gerber_drawn(ext["GTS"], 100, 0)
    gerber_drawn(ext["GTP"], 100, 0)
    gerber_drawn(ext["GKO"], 0, 4)
    drilled, routed = holes_drilled([ext["DRL"]])
    return {"zip": zips[0], "files": sorted(text), "holes": drilled, "slots": routed}
