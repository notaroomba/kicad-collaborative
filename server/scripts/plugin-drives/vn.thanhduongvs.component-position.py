"""Component Position Exporter (a Qt window over KiCad's IPC interface): once it has read the board, press "position"
and "BOM" and open the two CSV files in the project's assembly folder.  Every part must be listed at its own place,
measured as the window's origin and axis choices say, and the BOM must count every part once."""
# board: demos/royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb
import csv
import io
import os
import pcbnew
import wx
from PySide6.QtWidgets import QApplication
from drive_util import messages


def after_run(_action):
    wx._run_later()
    wins = [w for w in QApplication.topLevelWidgets() if type(w).__name__ == "MainWindow"]
    assert wins, "the plugin's window did not open: %s" % [type(w).__name__ for w in QApplication.topLevelWidgets()]
    win = wins[0]
    assert win.pcb.connected, "the window is not connected to the board: %s" % messages()
    ui = win.ui
    ui.buttonPosition.click()
    ui.buttonBOM.click()
    said = messages()
    assert sum(1 for m in said if "exported successfully" in m) >= 2 and not any("Failed" in m for m in said), said
    out = "/project/assembly"
    have = sorted(os.listdir(out))
    pos_file = [f for f in have if f.endswith(".csv") and not f.startswith("bom_")]
    assert "bom_RoyalBlue54L-Feather.csv" in have and len(pos_file) == 1, have
    board = pcbnew.GetBoard()
    fps = {fp.GetReference(): fp for fp in board.GetFootprints()}
    rows = list(csv.DictReader(io.StringIO(open(os.path.join(out, pos_file[0]), encoding="utf-8-sig").read())))
    assert {r["References"] for r in rows} == set(fps), sorted(set(fps) ^ {r["References"] for r in rows})[:10]
    ds = board.GetDesignSettings()
    origin = ds.GetGridOrigin() if ui.radioGridOrigin.isChecked() else ds.GetAuxOrigin() if ui.radioDrillOrigin.isChecked() else pcbnew.VECTOR2I(0, 0)
    sx, sy = (-1 if ui.radioIncreasesLeft.isChecked() else 1), (-1 if ui.radioIncreasesUp.isChecked() else 1)
    off = []
    for r in rows:
        fp = fps[r["References"]]
        p = fp.GetPosition()
        if abs(float(r["PosX (mm)"]) - sx * pcbnew.ToMM(p.x - origin.x)) > 0.001 or abs(float(r["PosY (mm)"]) - sy * pcbnew.ToMM(p.y - origin.y)) > 0.001:
            off.append(r["References"])
        if abs((float(r["Angle"]) - fp.GetOrientationDegrees() + 180) % 360 - 180) > 0.05 or r["Value"] != fp.GetValue() or (r["Layer"] == "Top") != (fp.GetLayer() == pcbnew.F_Cu):
            off.append(r["References"] + "*")
    assert not off, "rows that do not match the board: %s" % off[:10]
    bom = list(csv.DictReader(io.StringIO(open(os.path.join(out, "bom_RoyalBlue54L-Feather.csv"), encoding="utf-8-sig").read())))
    listed = []
    for r in bom:
        if not r["References"]:
            continue
        refs = [x.strip() for x in r["References"].split(",")]
        assert int(r["Quantity"]) == len(refs) and all(fps[x].GetValue() == r["Value"] for x in refs), r
        listed += refs
    assert sorted(listed) == sorted(fps), "the BOM does not count every part once: %d of %d" % (len(listed), len(fps))
    return {"files": have, "positions": len(rows), "bom_lines": len(bom), "origin": [origin.x, origin.y], "axes": [sx, sy]}
