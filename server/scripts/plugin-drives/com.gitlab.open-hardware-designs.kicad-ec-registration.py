"""eC-registration.  Panel: accept the window's own Eurocircuits values and expect the panel it announces: an outer
outline around the kept board outline, two 3 mm location holes 5 mm in from the panel's left edge and 10 mm from its
top and bottom, twelve 0.5 mm mouse bites sitting on the board's own edges in four tabs of three, three 1 mm frame
fiducials, and two 5 mm stencil holes on the stencil layer.  Stencil export: expect the paste and outline Gerbers and
the order notes to be written (their drawing is the editor's Gerber writer's, which this run does not have)."""
import os
import re
import pcbnew
from drive_util import messages

seen = {}


def _edge():
    xs, ys = [], []
    for d in pcbnew.GetBoard().GetDrawings():
        if d.GetLayer() == pcbnew.Edge_Cuts:
            for p in (d.GetStart(), d.GetEnd()):
                xs.append(pcbnew.ToMM(p.x))
                ys.append(pcbnew.ToMM(p.y))
    return min(xs), min(ys), max(xs), max(ys)


def modal(dlg):
    if "board" not in seen:
        seen["board"] = _edge()
    import wx
    return wx.ID_OK


def _pads(board, name):
    fps = [f for f in board.GetFootprints() if f.GetReference() == name]
    assert len(fps) == 1, "the board has %d footprints called %s" % (len(fps), name)
    mm = pcbnew.ToMM
    return [(mm(p.GetPosition().x), mm(p.GetPosition().y), mm(p.GetDrillSize().x), mm(p.GetSize().x), p.GetAttribute()) for p in fps[0].Pads()]


def after_run(action):
    board = pcbnew.GetBoard()
    said = messages()
    if "panel" in action:
        assert "board" in seen, "the eC-registration window never opened: %s" % said[-1:]
        bx0, by0, bx1, by1 = seen["board"]
        plan = next((m for m in said if "Panel outline" in m), "")
        m = re.search(r"Panel outline: ([\d.]+) x ([\d.]+) mm", plan)
        assert m, "the plugin did not announce its panel: %s" % said[-2:]
        px0, py0, px1, py1 = _edge()
        assert abs(px1 - px0 - float(m.group(1))) < 0.011 and abs(py1 - py0 - float(m.group(2))) < 0.011, \
            "the outline on the board is %.2f x %.2f mm, announced %s x %s" % (px1 - px0, py1 - py0, m.group(1), m.group(2))
        assert px0 < bx0 and py0 < by0 and px1 > bx1 and py1 > by1, "the panel does not surround the board"
        holes = sorted(_pads(board, "eC-registration-holes"), key=lambda h: h[1])
        assert len(holes) == 2 and all(abs(h[2] - 3) < 1e-6 and h[4] == pcbnew.PAD_ATTRIB_NPTH for h in holes), "the location holes are not two 3 mm unplated holes: %s" % holes
        assert all(abs(h[0] - (px0 + 5)) < 0.011 for h in holes), "the location holes are not 5 mm from the panel's left edge: %s" % [h[0] - px0 for h in holes]
        assert abs(holes[0][1] - (py0 + 10)) < 0.011 and abs(holes[1][1] - (py1 - 10)) < 0.011, "the location holes are not 10 mm from the top and bottom: %s" % [(h[1] - py0, py1 - h[1]) for h in holes]
        bites = _pads(board, "eC-mouse-bites")
        assert len(bites) == 12 and all(abs(b[2] - 0.5) < 1e-6 for b in bites), "not twelve 0.5 mm mouse bites: %d" % len(bites)
        sides = {"left": 0, "right": 0, "top": 0, "bottom": 0}
        for x, y, *_ in bites:
            for side, d in (("left", x - bx0), ("right", x - bx1), ("top", y - by0), ("bottom", y - by1)):
                if abs(d) < 0.011:
                    sides[side] += 1
        assert sides == {"left": 3, "right": 3, "top": 3, "bottom": 3}, "the mouse bites are not three on each edge of the board: %s" % sides
        fids = _pads(board, "eC-frame-fiducials")
        assert len(fids) == 3 and all(abs(f[3] - 1) < 1e-6 and f[2] == 0 for f in fids), "not three 1 mm fiducials: %s" % fids
        assert all(px0 < f[0] < px1 and py0 < f[1] < py1 and not (bx0 < f[0] < bx1 and by0 < f[1] < by1) for f in fids), "a fiducial is not on the panel frame"
        circles = [d for d in board.GetDrawings() if type(d).__name__ == "PCB_SHAPE" and d.GetShape() == pcbnew.SHAPE_T_CIRCLE and d.GetLayer() not in (pcbnew.Edge_Cuts,)]
        big = [c for c in circles if abs(pcbnew.ToMM(c.GetRadius()) - 2.5) < 0.001]
        assert len(big) == 2, "the stencil layer has %d holes of 5 mm, not 2" % len(big)
        seen["stencil_layer"] = board.GetLayerName(big[0].GetLayer())
        return {"panel_mm": [round(px1 - px0, 2), round(py1 - py0, 2)], "location_holes": [(round(h[0], 2), round(h[1], 2)) for h in holes], "mouse_bites": sides, "stencil_layer": seen["stencil_layer"]}
    folder = "/project/stencil-gerbers"
    files = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
    assert files == ["README-STENCIL.txt", "ecc83-pp-eC-stencil-TOP-apertures.gbr", "ecc83-pp-eC-stencil-TOP-outline.gbr"], "the stencil folder holds %s; the plugin said %s" % (files, said[-1:])
    assert "eC-stencil-mate" in open(folder + "/README-STENCIL.txt").read(), "the order notes are not the plugin's"
    assert any("Stencil Gerber set written" in m for m in said), "the plugin did not report the export: %s" % said[-1:]
    return {"files": files}
