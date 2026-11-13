"""PCBWay Fabrication Toolkit: one press writes a dated folder under the project's pcbway_production folder.  Open it: the Gerber and drill
archive, the BOM, the placement file and the netlist must each hold this board."""
# board: demos/royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb
import os
import csv
import io
import zipfile
import wx
import pcbnew
from drive_util import messages, gerber_drawn, holes_drilled, parts_placed


def after_run(_action):
    wx._run_later()
    assert not any("rror" in m for m in messages()), messages()
    root = "/project/pcbway_production"
    runs = sorted(os.listdir(root))
    assert len(runs) == 1, runs
    out = os.path.join(root, runs[0])
    have = sorted(os.listdir(out))
    stem = "RoyalBlue54L-Feather.kicad_pcb"      # the plugin names its files after the board file, extension and all
    assert {stem + "_gerber.zip", stem + "_bom.csv", stem + "_positions.csv", stem + "_netlist.ipc"} <= set(have), have
    with zipfile.ZipFile(os.path.join(out, stem + "_gerber.zip")) as z:
        text = {n: z.read(n).decode("utf-8", "replace") for n in z.namelist()}
    names = sorted(text)
    for layer in ("F_Cu", "B_Cu", "F_Mask", "B_Mask", "F_Paste", "Edge_Cuts"):
        assert any(layer in n for n in names), "no %s Gerber in the archive: %s" % (layer, names)
    gerber_drawn(text[[n for n in names if "F_Cu" in n][0]], 100, 100)
    gerber_drawn(text[[n for n in names if "Edge_Cuts" in n][0]], 0, 4)
    drilled, routed = holes_drilled([text[n] for n in names if n.lower().endswith(".drl")])
    refs = {fp.GetReference().upper() for fp in pcbnew.GetBoard().GetFootprints()}
    pos = list(csv.DictReader(io.StringIO(open(os.path.join(out, stem + "_positions.csv"), encoding="utf-8-sig").read())))
    assert parts_placed(pos, "designator", "pos_x", "pos_y") > 20
    bom = list(csv.DictReader(io.StringIO(open(os.path.join(out, stem + "_bom.csv"), encoding="utf-8-sig").read())))
    named = set()
    for r in bom:
        named |= {d.strip().upper() for d in r["Designator"].split(",")}
    assert len(bom) > 5 and named <= refs, bom[:2]
    ipc = open(os.path.join(out, stem + "_netlist.ipc"), encoding="utf-8", errors="replace").read()
    assert ipc.count("\n327") + ipc.count("\n317") > 50, ipc[:300]
    return {"folder": runs[0], "in_archive": names, "placed": len(pos), "bom_lines": len(bom), "holes": drilled, "slots": routed}
