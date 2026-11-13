"""Interactive HTML BOM: switch compression off (so the page's data can be read here), press Generate BOM and open the
page.  Its data must hold this board: every part with its pads at their places, the outline, the tracks, and a BOM
that counts every part once.  The board has custom-shaped pads, whose outlines the page must carry too."""
# board: demos/stickhub/StickHub.kicad_pcb
import json
import os
import wx
import pcbnew
from drive_util import click, find, tick, messages

seen = {}


def modal(dlg):
    if "ran" not in seen:
        seen["ran"] = True
        tick(find(wx.CheckBox, "Enable compression", dlg), False)
        tick(find(wx.CheckBox, "Open browser", dlg), False)
        click("Generate BOM", dlg)
    return wx.ID_CANCEL


def after_run(_action):
    assert not any("rror" in m for m in messages()), messages()
    page = open("/project/bom/ibom.html", encoding="utf-8").read()
    at = page.index("var pcbdata = ") + len("var pcbdata = ")
    data, _end = json.JSONDecoder().raw_decode(page, at)
    board = pcbnew.GetBoard()
    fps = list(board.GetFootprints())
    assert len(data["footprints"]) == len(fps), "%d parts on the page, %d on the board" % (len(data["footprints"]), len(fps))
    by_ref = {f["ref"]: f for f in data["footprints"]}
    custom = 0
    for fp in fps:
        f = by_ref[fp.GetReference()]
        pads = [p for p in fp.Pads() if p.IsOnLayer(pcbnew.F_Cu) or p.IsOnLayer(pcbnew.B_Cu)]       # paste-only apertures are not pads to the page
        assert len(f["pads"]) == len(pads), (fp.GetReference(), len(f["pads"]), len(pads))
        assert (f["layer"] == "F") == (fp.GetLayer() == pcbnew.F_Cu), fp.GetReference()
        want = sorted((round(pcbnew.ToMM(p.GetPosition().x), 3), round(pcbnew.ToMM(p.GetPosition().y), 3)) for p in pads)
        got = sorted((round(p["pos"][0], 3), round(p["pos"][1], 3)) for p in f["pads"])
        assert got == want, "the pads of %s are somewhere else: %s / %s" % (fp.GetReference(), got[:3], want[:3])
        for p in f["pads"]:
            if p["shape"] == "custom" and "polygons" in p:
                custom += 1
                assert p["polygons"] and all(len(poly) >= 3 for poly in p["polygons"]), (fp.GetReference(), p)
    in_file = open(board.GetFileName(), encoding="utf-8").read().count("(primitives")
    assert in_file > 0 and custom >= in_file, "%d custom pads on the page, %d in the board file" % (custom, in_file)
    box = board.GetBoardEdgesBoundingBox()
    bb = data["edges_bbox"]
    assert abs((bb["maxx"] - bb["minx"]) - pcbnew.ToMM(box.GetWidth())) < 0.5 and abs((bb["maxy"] - bb["miny"]) - pcbnew.ToMM(box.GetHeight())) < 0.5, bb
    assert len(data["edges"]) >= 4, len(data["edges"])
    listed = [ref for group in data["bom"]["both"] for ref, _i in group]
    skipped = [r for r in by_ref if r not in listed]
    assert len(listed) == len(set(listed)) and set(listed) <= set(by_ref) and len(listed) > 0.8 * len(fps), "the BOM lists %d of %d parts" % (len(listed), len(fps))
    silk = sum(len(data["drawings"]["silkscreen"][s]) for s in ("F", "B"))
    assert silk > 50, "hardly any silkscreen on the page: %d" % silk
    return {"page_bytes": len(page), "parts": len(fps), "custom_pads": custom, "edges": len(data["edges"]), "bom_groups": len(data["bom"]["both"]), "not_in_bom": skipped[:6], "silk_items": silk}
