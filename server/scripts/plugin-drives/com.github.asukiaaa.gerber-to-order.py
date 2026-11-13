"""Gerber to order: press Export and open the five archives it writes (Default, Elecrow, FusionPCB, PCBWay, JLCPCB).
The plugin is written for KiCad 6 (it asks an outline arc for its start angle, which later KiCad versions no longer
answer).  Each archive must hold this board's copper, mask, silkscreen and outline Gerbers and drill files with every hole of the board."""
# board: demos/stickhub/StickHub.kicad_pcb
import os
import zipfile
import wx
from drive_util import click, messages, gerber_drawn, holes_drilled

seen = {}


def modal(dlg):
    if "ran" not in seen:
        seen["ran"] = True
        click("Export", dlg)
    return wx.ID_CANCEL


def after_run(_action):
    said = messages()
    assert any("Exported" in m for m in said) and not any("rror" in m for m in said), said
    out = "/project/gerber_to_order"
    zips = sorted(f for f in os.listdir(out) if f.endswith(".zip"))
    services = [z.rsplit("_for_", 1)[1][:-4] for z in zips]
    assert services == ["Default", "Elecrow", "FusionPCB", "JLCPCB", "PCBWay"], zips
    # the archives are named after the board's size, which the plugin measures from the outline (arcs included)
    import pcbnew
    box = pcbnew.GetBoard().GetBoardEdgesBoundingBox()
    w, h = (float(v) for v in zips[0].split("_")[1][:-2].split("x"))
    assert abs(w - pcbnew.ToMM(box.GetWidth())) < 0.3 and abs(h - pcbnew.ToMM(box.GetHeight())) < 0.3, "named %s, the outline is %.2f by %.2f mm" % (zips[0], pcbnew.ToMM(box.GetWidth()), pcbnew.ToMM(box.GetHeight()))
    report = {"size": [w, h]}
    for name in zips:
        with zipfile.ZipFile(os.path.join(out, name)) as z:
            text = {n: z.read(n).decode("utf-8", "replace") for n in z.namelist() if not n.endswith("/")}
        gerbers = {n: t for n, t in text.items() if "%FSLAX" in t}
        drills = [t for n, t in text.items() if t.startswith("M48")]
        assert len(gerbers) == 7 and len(gerbers) + len(drills) == len(text), "%s holds %s" % (name, sorted(text))       # 2 copper, 2 mask, 2 silk, outline
        most = max(gerber_drawn(t)[0] for t in gerbers.values())
        assert most > 100 and all(gerber_drawn(t)[1] + gerber_drawn(t)[0] > 0 for t in gerbers.values()), "%s has an empty layer" % name
        drilled, routed = holes_drilled(drills)
        report[name.rsplit("_for_", 1)[1][:-4]] = [len(gerbers), len(drills), drilled, routed]
    return report
