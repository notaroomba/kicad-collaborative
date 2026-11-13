"""SparkFun Panelizer: press Panelize with the settings the dialog opens with (a panel smaller than 5.5 by 7.5 inches,
no gaps) and open the panel file it writes.  The 16.5 by 40 mm board must be there 8 by 4 times: every part 32 times
on one lattice (the board's size plus the plugin's V-score allowance), each with its pads, the tracks with them, and V-score lines between the boards.  The open board itself must stay as it was."""
# board: demos/stickhub/StickHub.kicad_pcb
import os
import wx
import pcbnew
from drive_util import click, messages

seen = {}


def modal(dlg):
    if "ran" not in seen:
        seen["ran"] = True
        seen["parts"] = {fp.GetReference(): (fp.GetPosition().x, fp.GetPosition().y) for fp in pcbnew.GetBoard().GetFootprints()}
        seen["pads"] = sum(len(list(fp.Pads())) for fp in pcbnew.GetBoard().GetFootprints())
        seen["tracks"] = len(list(pcbnew.GetBoard().GetTracks()))
        click("Panelize", dlg)
        return wx.ID_OK
    return wx.ID_CANCEL


def after_run(_action):
    said = messages()
    log = open("/project/Production/panelizer.log", encoding="utf-8", errors="replace").read()
    assert any("Panelizer" in m for m in said) and not any("error" in m.lower() for m in said), (said, log[-600:])
    assert "You can fit 8 x 4 boards on the panel." in log, log[-800:]
    path = "/project/Production/StickHub_panelized.kicad_pcb"
    assert os.path.exists(path), sorted(os.listdir("/project/Production"))
    panel = pcbnew.LoadBoard(path)
    by_ref = {}
    for fp in panel.GetFootprints():
        by_ref.setdefault(fp.GetReference(), []).append((fp.GetPosition().x, fp.GetPosition().y))
    # the pitch the plugin chose (the board's size plus its V-score allowance), read off one part and held to for all
    first = next(iter(seen["parts"]))
    xs, ys = sorted({p[0] for p in by_ref[first]}), sorted({p[1] for p in by_ref[first]})
    assert len(xs) == 8 and len(ys) == 4, (first, len(xs), len(ys))
    W, H = xs[1] - xs[0], ys[1] - ys[0]
    assert pcbnew.FromMM(16.5) <= W <= pcbnew.FromMM(18) and pcbnew.FromMM(40) <= H <= pcbnew.FromMM(41.5), "pitch %.3f by %.3f mm" % (pcbnew.ToMM(W), pcbnew.ToMM(H))
    wrong = []
    for ref, (x, y) in seen["parts"].items():
        at = by_ref.get(ref, [])
        steps = sorted((round((px - x) / W, 3), round((y - py) / H, 3)) for px, py in at)
        if steps != sorted((float(i), float(j)) for i in range(8) for j in range(4)):
            wrong.append((ref, len(at), steps[:4]))
    assert not wrong, "parts not copied 8 by 4 at one pitch: %s" % wrong[:5]
    pads = sum(len(list(fp.Pads())) for fp in panel.GetFootprints())
    assert pads >= 32 * seen["pads"], "%d pads on the panel, %d on one board" % (pads, seen["pads"])
    tracks = len(list(panel.GetTracks()))
    assert tracks == 32 * seen["tracks"], "%d tracks on the panel, %d on one board" % (tracks, seen["tracks"])
    box = panel.GetBoardEdgesBoundingBox()
    assert abs(box.GetWidth() - 8 * W) < pcbnew.FromMM(1.5) and abs(box.GetHeight() - 4 * H) < pcbnew.FromMM(1.5), (pcbnew.ToMM(box.GetWidth()), pcbnew.ToMM(box.GetHeight()))
    score = [d for d in panel.GetDrawings() if d.GetClass() == "PCB_SHAPE" and d.GetLayer() == pcbnew.Cmts_User and d.GetShape() == pcbnew.SHAPE_T_SEGMENT]
    upright = sum(1 for d in score if d.GetStart().x == d.GetEnd().x and abs(d.GetStart().y - d.GetEnd().y) > 3 * H)
    level = sum(1 for d in score if d.GetStart().y == d.GetEnd().y and abs(d.GetStart().x - d.GetEnd().x) > 7 * W)
    assert upright >= 7 and level >= 3, "V-score lines: %d upright, %d level" % (upright, level)
    # the plugin renames the open board before saving (a "save as"): the panel is its own file and nothing of it goes
    # to the project's live board
    import kicad_web
    assert kicad_web._saved_as[0] == path, kicad_web._saved_as
    return {"boards": 32, "pitch_mm": [pcbnew.ToMM(W), pcbnew.ToMM(H)], "pads": pads, "parts": sum(len(v) for v in by_ref.values()), "tracks": tracks, "panel_mm": [pcbnew.ToMM(box.GetWidth()), pcbnew.ToMM(box.GetHeight())], "v_scores": [upright, level]}
