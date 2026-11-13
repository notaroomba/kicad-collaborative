"""Fabrication Toolkit (JLCPCB): press Generate and open what lands in the project's production folder: the Gerber and
drill archive, the BOM, the placement file and the netlist, each holding this board."""
# board: demos/royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb
import os
import csv
import io
import zipfile
import wx
import pcbnew
from drive_util import windows, click, messages, gerber_drawn, holes_drilled, parts_placed


def after_run(_action):
    wins = [w for w in windows() if "Fabrication Toolkit" in str(w.GetTitle())]
    assert wins, "the plugin's window did not open: %s" % [str(w.GetTitle()) for w in windows()]
    click("Generate", wins[0])
    wx._run_later()
    assert not any("rror" in m for m in messages()), messages()
    out = "/project/production"
    have = sorted(os.listdir(out))
    zips = [f for f in have if f.lower().endswith(".zip")]
    assert zips and {"bom.csv", "positions.csv", "netlist.ipc"} <= set(have), have
    with zipfile.ZipFile(os.path.join(out, zips[0])) as z:
        text = {n: z.read(n).decode("utf-8", "replace") for n in z.namelist()}
    names = sorted(text)
    low = [n.lower() for n in names]
    for end in (".gtl", ".gbl", ".gto", ".gts", ".gbs", ".gtp", ".gm1", ".drl"):
        assert any(n.endswith(end) for n in low), "no %s in the archive: %s" % (end, names)
    gerber_drawn(text[[n for n in names if n.lower().endswith(".gtl")][0]], 100, 100)
    gerber_drawn(text[[n for n in names if n.lower().endswith(".gm1")][0]], 0, 4)
    drilled, routed = holes_drilled([text[n] for n in names if n.lower().endswith(".drl")])
    # the placement file and the BOM name the board's own parts
    refs = {fp.GetReference().upper() for fp in pcbnew.GetBoard().GetFootprints()}
    pos = list(csv.DictReader(io.StringIO(open(os.path.join(out, "positions.csv"), encoding="utf-8-sig").read())))
    assert parts_placed(pos) > 20
    bom = list(csv.DictReader(io.StringIO(open(os.path.join(out, "bom.csv"), encoding="utf-8-sig").read())))
    named = set()
    for r in bom:
        named |= {d.strip() for d in r["Designator"].split(",")}
    assert len(bom) > 5 and named <= refs and {r["Designator"] for r in pos} <= named, bom[:2]
    ipc = open(os.path.join(out, "netlist.ipc"), encoding="utf-8", errors="replace").read()
    assert ipc.count("\n327") + ipc.count("\n317") > 50, ipc[:300]
    return {"archive": zips[0], "in_archive": names, "placed": len(pos), "bom_lines": len(bom), "holes": drilled, "slots": routed}
