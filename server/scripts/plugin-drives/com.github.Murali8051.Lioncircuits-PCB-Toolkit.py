"""LionCircuits fabrication export: leave every output ticked, press Generate and open the output folder: Gerbers and
drill files (and their zip), both BOMs, the position file, the interactive BOM page and the IPC-D-356 netlist must each
hold this board."""
# board: demos/stickhub/StickHub.kicad_pcb
import os
import csv
import io
import zipfile
import wx
import pcbnew
from drive_util import messages, gerber_drawn, holes_drilled, parts_placed

OUT = "/project/lioncircuits_output"


def modal(dlg):
    return wx.ID_OK if type(dlg).__name__ == "LionCircuitsDialog" else wx.ID_CANCEL


def after_run(_action):
    said = messages()
    assert said and said[-1].endswith("Done") and not any("rror" in m for m in said), said
    have = sorted(os.listdir(OUT))
    assert {"gerbers", "gerbers.zip", "bom_for_assembly.csv", "positions.csv", "netlist.ipc"} <= set(have), have
    with zipfile.ZipFile(os.path.join(OUT, "gerbers.zip")) as z:
        text = {n: z.read(n).decode("utf-8", "replace") for n in z.namelist()}
    assert sorted(os.path.basename(n) for n in text) == sorted(f for f in os.listdir(os.path.join(OUT, "gerbers"))
                                                                 if os.path.splitext(f)[1].lower() in (".gbr", ".gbrjob", ".drl", ".gbl", ".gtl", ".gto", ".gbo", ".gts", ".gbs", ".gko", ".gtp", ".gbp", ".txt")), sorted(text)
    gerbers = {n: t for n, t in text.items() if "%FSLAX" in t}
    assert {"TOP.GTL", "BOTTOM.GBL", "TOPMASK.GTS", "BOTTOMMASK.GBS", "TOPSILK.GTO", "BOTTOMSILK.GBO", "TOPPASTE.GTP", "OUTLINE.GKO"} == {os.path.basename(n) for n in gerbers}, sorted(gerbers)
    by = {os.path.basename(n): t for n, t in gerbers.items()}
    gerber_drawn(by["TOP.GTL"], 100, 100)
    gerber_drawn(by["BOTTOM.GBL"], 20, 20)
    gerber_drawn(by["TOPPASTE.GTP"], 100, 0)
    gerber_drawn(by["OUTLINE.GKO"], 0, 4)
    drilled, routed = holes_drilled([t for t in text.values() if t.startswith("M48")])
    refs = {fp.GetReference() for fp in pcbnew.GetBoard().GetFootprints()}
    pos = list(csv.DictReader(io.StringIO(open(os.path.join(OUT, "positions.csv"), encoding="utf-8-sig").read())))
    assert parts_placed(pos, "Ref", "PosX(mm)", "PosY(mm)") > 20
    bom = list(csv.DictReader(io.StringIO(open(os.path.join(OUT, "bom_for_assembly.csv"), encoding="utf-8-sig").read())))
    named = set()
    for r in bom:
        named |= {d.strip() for d in r["Designator"].split(",")}
        assert int(r["Unit Quantity"]) == len(r["Designator"].split(",")), r
    assert len(bom) > 5 and named <= refs and {r["Ref"] for r in pos} <= named, bom[:2]
    ipc = open(os.path.join(OUT, "netlist.ipc"), encoding="utf-8", errors="replace").read()
    assert ipc.count("\n327") + ipc.count("\n317") > 50, ipc[:300]
    pages = [f for f in have if f.lower().endswith(".html")]
    assert pages, have
    page = open(os.path.join(OUT, pages[0]), encoding="utf-8", errors="replace").read()
    assert "<html" in page.lower() and sum(1 for r in sorted(refs)[:40] if r in page) >= 30, "the interactive BOM page does not name the board's parts"
    quotes = [f for f in have if f not in ("gerbers", "gerbers.zip", "bom_for_assembly.csv", "positions.csv", "netlist.ipc") and f not in pages]
    assert quotes and all(os.path.getsize(os.path.join(OUT, f)) > 200 for f in quotes), have
    return {"files": have, "in_zip": len(text), "placed": len(pos), "bom_lines": len(bom), "holes": drilled, "slots": routed, "page_bytes": len(page)}
