# select: 00000000-0000-0000-0000-00005a334ccc
"""kicad-action-scripts.  Circular Zone: with the valve U1 selected, ask for a 7 mm keep-out circle of 24 segments
and expect a new rule area whose 24 corners all lie 7 mm from U1.  Via Stitching Generator: fill the GND pour with
0.6 mm vias on a 2 mm step at 0.3 mm clearance and expect new GND vias, all inside the pour's outline, on the step,
and none nearer than the clearance to a pad or a track of another net."""
import math
import pcbnew
import wx
from drive_util import choose, click, messages

seen = {}
STEP, SIZE, CLEAR = 2.0, 0.6, 0.3


def _vias():
    return [t for t in pcbnew.GetBoard().GetTracks() if isinstance(t, pcbnew.PCB_VIA)]


def _ids(items):
    return {i.m_Uuid.AsString() for i in items}


def modal(dlg):
    name = type(dlg).__name__
    if name == "CircularZoneDlg":
        seen["zones"] = _ids(pcbnew.GetBoard().Zones())
        seen["comment"] = dlg.m_comment.GetLabel()
        dlg.m_radiusMM.SetValue("7")
        dlg.m_textCtrl_seg.SetValue("24")
        dlg.m_radio_out.SetValue(True)
        return wx.ID_OK
    if name == "FillAreaDialogEx":
        seen["vias"] = _ids(_vias())
        dlg.m_SizeMM.SetValue(str(SIZE))
        dlg.m_DrillMM.SetValue("0.3")
        dlg.m_ClearanceMM.SetValue(str(CLEAR))
        dlg.m_StepMM.SetValue(str(STEP))
        choose(dlg.m_cbNet, "GND")
        dlg.m_Random.SetValue(False)
        return wx.ID_OK
    return wx.ID_OK


def _seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = 0 if not (dx or dy) else max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def after_run(action):
    board = pcbnew.GetBoard()
    mm = pcbnew.ToMM
    if "Circular" in action:
        assert "zones" in seen, "the Circular Zone window never opened"
        assert "U1" in seen["comment"], "the window does not name the selected part: %s" % seen["comment"]
        new = [z for z in board.Zones() if z.m_Uuid.AsString() not in seen["zones"]]
        assert len(new) == 1, "%d zones were added: %s" % (len(new), messages()[-2:])
        zone = new[0]
        assert zone.GetIsRuleArea() and zone.GetDoNotAllowTracks() and zone.GetDoNotAllowVias(), "the zone is not a keep-out"
        centre = board.FindFootprintByReference("U1").GetPosition()
        outline = zone.Outline().Outline(0)
        radii = [math.hypot(mm(outline.CPoint(i).x - centre.x), mm(outline.CPoint(i).y - centre.y)) for i in range(outline.PointCount())]
        assert len(radii) == 24, "the circle has %d corners, 24 were asked for" % len(radii)
        assert all(abs(r - 7) < 0.001 for r in radii), "corners are %.3f to %.3f mm from U1, not 7" % (min(radii), max(radii))
        return {"corners": len(radii), "radius_mm": round(sum(radii) / len(radii), 4)}
    assert "vias" in seen, "the Via Stitching window never opened: %s" % messages()[-2:]
    new = [v for v in _vias() if v.m_Uuid.AsString() not in seen["vias"]]
    assert len(new) >= 30, "only %d vias were added: %s" % (len(new), messages()[-2:])
    assert all(v.GetNetname() == "GND" for v in new), "vias on other nets: %s" % sorted({v.GetNetname() for v in new})
    assert all(abs(mm(v.GetWidth(pcbnew.F_Cu)) - SIZE) < 1e-6 for v in new), "the vias are not %.1f mm" % SIZE
    zones = [z for z in board.Zones() if z.GetNetname() == "GND"]
    outside = [v for v in new if not any(z.Outline().Contains(v.GetPosition()) for z in zones)]
    assert not outside, "%d of %d vias are outside the GND pour" % (len(outside), len(new))
    pts = [(mm(v.GetPosition().x), mm(v.GetPosition().y)) for v in new]
    near = min(math.hypot(a[0] - b[0], a[1] - b[1]) for i, a in enumerate(pts) for b in pts[i + 1:])
    assert near > STEP - 0.01, "two vias are %.3f mm apart, closer than the %.1f mm step" % (near, STEP)
    tight = []
    for t in board.GetTracks():
        if isinstance(t, pcbnew.PCB_VIA) or t.GetNetname() == "GND":
            continue
        a, b = (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
        for p in pts:
            gap = _seg_dist(p, a, b) - mm(t.GetWidth()) / 2 - SIZE / 2
            if gap < CLEAR - 0.01:
                tight.append(("track", t.GetNetname(), round(gap, 3)))
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetname() == "GND":
                continue
            c, size = pad.GetPosition(), pad.GetSize()
            reach = min(mm(size.x), mm(size.y)) / 2          # the circle every pad shape contains
            for p in pts:
                gap = math.hypot(p[0] - mm(c.x), p[1] - mm(c.y)) - reach - SIZE / 2
                if gap < CLEAR - 0.01:
                    tight.append((fp.GetReference(), pad.GetNumber(), round(gap, 3)))
    assert not tight, "%d vias are nearer than %.1f mm to other nets' copper: %s" % (len(tight), CLEAR, tight[:4])
    return {"vias": len(new), "closest_mm": round(near, 3)}
