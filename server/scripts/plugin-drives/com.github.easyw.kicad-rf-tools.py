"""RF tools, each of its nine commands with its own inputs on the valve amplifier board.
Wizards: a 90 degree arc pad of 4 mm radius and 1 mm width, a mitered bend for a 2 mm line on 1.6 mm board (two 2 mm arms, the outside corner cut at 45 degrees), and a
taper from 0.4 mm to 1.2 mm over 4 mm; each must land on the board with the copper those numbers describe.
Track tools, on the 0.8 mm track from U1 that turns 45 degrees: round the corner 1 mm from it (one arc of
tan(67.5 deg) = 2.414 mm radius, both tracks shortened by 1 mm), widen the solder mask over the straight part by
0.3 mm a side, put a taper zone on its end, measure it (13.615 mm), fence it with 0.6 mm GND vias 1.2 mm off its
axis about 1.5 mm apart, and surround it with a keep-out 0.4 mm from its copper."""
import math
import re
import pcbnew
import wx
from drive_util import choose, click, messages

mm = pcbnew.ToMM
seen = {}
A, B = "d7a2ea41-4fea-4c56-89ef-27fec710c0ad", "68e5151f-158a-448d-b289-866542b41d38"
X, Y0, Y1 = 156.21, 95.885, 109.5              # the straight part of the track once its corner is rounded
WIZARD = {"uW Arc Pad": {"width": "1.0", "radius": "4.0"},
          "uW Mitered Bend": {"width": "2.0", "height": "1.6"},
          "uW Taper Pad": {"P1 width": "0.4", "P1 height": "0.4", "P2 width": "1.2", "P2 height": "1.2", "length": "4.0"}}


def _ids():
    b = pcbnew.GetBoard()
    return {i.m_Uuid.AsString() for i in list(b.GetTracks()) + list(b.Zones()) + list(b.GetDrawings()) + list(b.GetFootprints())}


def _new():
    b = pcbnew.GetBoard()
    old = seen.pop("ids")
    return [i for i in list(b.GetTracks()) + list(b.Zones()) + list(b.GetDrawings()) + list(b.GetFootprints()) if i.m_Uuid.AsString() not in old]


def _straight():
    return [t for t in pcbnew.GetBoard().GetTracks() if type(t).__name__ == "PCB_TRACK"
            and abs(mm(t.GetStart().x) - X) < 1e-3 and abs(mm(t.GetEnd().x) - X) < 1e-3
            and {round(mm(t.GetStart().y), 3), round(mm(t.GetEnd().y), 3)} == {Y0, Y1}]


def _pick(tracks):
    """Click these tracks, as a person does before the next command: the plugin's own commands drop the selection."""
    b = pcbnew.GetBoard()
    for it in list(b.GetTracks()) + list(b.GetFootprints()):
        it.ClearSelected()
    for t in tracks:
        t.SetSelected()
    pcbnew.Refresh()


def modal(dlg):
    seen.setdefault("ids", _ids())
    name = type(dlg).__name__
    seen["window"] = name
    if name == "WizardDialog":
        for p, c in dlg.controls:
            if p.name in WIZARD[str(dlg.wizard.GetName())]:
                c.SetValue(WIZARD[str(dlg.wizard.GetName())][p.name])
                c._wx_fire(wx.EVT_TEXT, wx.Event(c, wx.EVT_TEXT))
        seen["notes"] = dlg.messages.GetValue()
        click("Place on Board", dlg)
        return wx.ID_CANCEL
    if name == "RoundTrack_Dlg":
        dlg.m_distanceMM.SetValue("1")
        click("Round", dlg)
    elif name == "SolderExpander_Dlg":
        dlg.m_clearanceMM.SetValue("0.3")
        click("OK", dlg)
    elif name == "MainDialog":
        dlg.txtViaOffset.SetValue("1.2")
        dlg.txtViaPitch.SetValue("1.5")
        dlg.txtViaSize.SetValue("0.6")
        dlg.txtViaDrill.SetValue("0.3")
        choose(dlg.lstViaNet, "GND")
        click("OK", dlg)
    elif name == "TraceClearance_Dlg":
        dlg.m_clearance.SetValue("0.4")
        click("OK", dlg)
    else:
        return wx.ID_OK
    return dlg.GetReturnCode()


def _pads(fp):
    o = fp.GetPosition()
    return [(round(mm(p.GetPosition().x - o.x), 3), round(mm(p.GetPosition().y - o.y), 3), round(mm(p.GetSize().x), 3), round(mm(p.GetSize().y), 3), p.GetPrimitives()) for p in fp.Pads()]


def _points(node):
    return [(float(c[1]), float(c[2])) for c in node if isinstance(c, list) and str(c[0]) in ("xy", "start", "mid", "end")]


def _wizard(action):
    assert seen.get("window") == "WizardDialog", "the wizard's window never opened"
    fps = [i for i in _new() if isinstance(i, pcbnew.FOOTPRINT)]
    assert len(fps) == 1, "%d footprints landed on the board; the wizard said: %s" % (len(fps), seen.get("notes", "")[-300:])
    pads = _pads(fps[0])
    assert len(pads) == 2, "the footprint has %d pads, not 2" % len(pads)
    shapes = [c for c in pads[0][4]]
    assert len(shapes) == 1, "the first pad carries %d custom shapes, not 1" % len(shapes)
    kind, shape = str(shapes[0][0]), shapes[0]
    if "Arc" in action:
        pts = _points([c for c in shape if isinstance(c, list) and str(c[0]) in ("start", "mid", "end")])
        width = [float(c[1]) for c in shape if isinstance(c, list) and str(c[0]) == "width"][0]
        assert kind == "gr_arc" and abs(width - 1.0) < 1e-6, "the pad's shape is a %s of width %s, not a 1 mm arc" % (kind, width)
        assert pts[0] == (0, 0) and all(abs(math.hypot(x, y - 4) - 4) < 1e-3 for x, y in pts), "the arc is not on a 4 mm circle through the pad: %s" % pts
        assert pads[1][:2] == (4, 4) and pads[0][2] == 1, "the end pad is at %s, not a quarter turn of 4 mm radius away" % (pads[1][:2],)
        return {"arc": pts, "end_pad": pads[1][:2]}
    pts = _points([c for c in shape if isinstance(c, list) and str(c[0]) == "pts"][0])
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    if "Mitered" in action:
        cut = re.search(r"Cut: ([\d.]+)%", seen["notes"])
        assert cut and "Track Width: 2.0000mm" in seen["notes"] and "PCB Height: 1.6000mm" in seen["notes"], "the wizard did not take the values: %s" % seen["notes"][-200:]
        assert kind == "gr_poly" and min(xs) == -1 and (1, 0) in pts and (-1, 0) in pts, "the bend does not start 2 mm wide: %s" % pts
        assert pads[0][2:4] == (2, 1) and pads[1][2:4] == (1, 2), "the two end pads are %s and %s" % (pads[0][2:4], pads[1][2:4])
        inner = (1, 2) in pts                                # the inside corner of the two 2 mm arms
        miter = sorted(p for p in pts if p[0] not in (1, 3) and p[1] not in (0, 2) and p != (-1, 0))[:2]
        run = (miter[1][0] - miter[0][0], miter[1][1] - miter[0][1]) if len(miter) == 2 else (0, 1)
        assert inner and abs(run[0] - run[1]) < 1e-3 and run[0] > 1, "the outside corner is not cut at 45 degrees: %s" % pts
        return {"cut_percent": float(cut.group(1)), "outline": pts}
    assert kind == "gr_poly" and (min(ys), max(ys)) == (-0.6, 0.6) and (-0.2, -0.2) in pts and (-0.2, 0.2) in pts, "the taper does not go from 0.4 mm to 1.2 mm: %s" % pts
    assert (3.6, -0.6) in pts and (3.6, 0.6) in pts and pads[1][:4] == (4.2, 0, 1.2, 1.2), "the wide end is not 4 mm along: %s, pad %s" % (pts, pads[1][:4])
    return {"outline": pts, "wide_pad": pads[1][:4]}


def after_run(action):
    seen.setdefault("ids", _ids())
    board = pcbnew.GetBoard()
    said = messages()
    try:
        if action.startswith("Footprint Wizard"):
            out = _wizard(action)
            if "Taper" in action:
                _pick([t for t in board.GetTracks() if t.m_Uuid.AsString() in (A, B)])
            return out
        new = _new()
        if "Rounder" in action:
            gone = {A, B} & {t.m_Uuid.AsString() for t in board.GetTracks()}
            arcs = [t for t in new if type(t).__name__ == "PCB_ARC"]
            assert not gone and len(arcs) == 1 and len(new) == 3, "rounding left %d of the two tracks and added %s" % (len(gone), [type(t).__name__ for t in new])
            arc = arcs[0]
            ends = {(round(mm(p.x), 3), round(mm(p.y), 3)) for p in (arc.GetStart(), arc.GetEnd())}
            assert ends == {(X, Y1), (155.503, 111.207)}, "the arc joins %s, not the points 1 mm either side of the corner" % sorted(ends)
            assert abs(mm(arc.GetRadius()) - math.tan(math.radians(67.5))) < 0.002, "the arc's radius is %.3f mm, not 2.414" % mm(arc.GetRadius())
            assert mm(arc.GetWidth()) == 0.8 and arc.GetNetname() == "Net-(U1B-K)" and arc.GetLayer() == pcbnew.B_Cu, "the arc is not the track's width, net and layer"
            assert len(_straight()) == 1, "the straight track does not end 1 mm before the corner"
            return {"radius_mm": round(mm(arc.GetRadius()), 3), "arc_ends": sorted(ends)}
        if "Solder Mask" in action:
            assert len(new) == 1 and new[0].GetLayer() == pcbnew.B_Mask, "the mask opening is not one line on the bottom mask: %s" % [type(i).__name__ for i in new]
            line = new[0]
            ends = {(round(mm(p.x), 3), round(mm(p.y), 3)) for p in (line.GetStart(), line.GetEnd())}
            assert ends == {(X, Y0), (X, Y1)} and abs(mm(line.GetWidth()) - 1.4) < 1e-6, "the opening runs %s at %.2f mm, not along the track at 0.8 + 2 x 0.3" % (sorted(ends), mm(line.GetWidth()))
            return {"mask_width_mm": mm(line.GetWidth())}
        if "Tapers" in action:
            zones = [z for z in new if isinstance(z, pcbnew.ZONE)]
            assert len(zones) == 1 and len(new) == 1, "the taper is not one zone: %s; %s" % ([type(i).__name__ for i in new], said[-1:])
            z = zones[0]
            o = z.Outline().Outline(0)
            pts = sorted((round(mm(o.CPoint(i).x), 3), round(mm(o.CPoint(i).y), 3)) for i in range(o.PointCount()))
            assert pts == [(155.81, 109.1), (155.81, 109.9), (156.61, 109.1), (156.61, 109.9)], "the taper zone is %s, not the track's width square on its end" % pts
            assert z.GetNetname() == "Net-(U1B-K)" and z.GetLayer() == pcbnew.B_Cu and not z.GetIsRuleArea(), "the taper zone is not copper on the track's net and layer"
            return {"zone": pts}
        if "Measure" in action:
            told = [m for m in said if "Selected Tracks Length" in m]
            assert told and "13.615 mm" in told[-1] and "-90.0 deg" in told[-1], "the length reported is not 13.615 mm at -90 degrees: %s" % said[-1:]
            assert not new, "measuring changed the board"
            return {"told": told[-1][:80]}
        if "Via Fence" in action:
            vias = [v for v in new if isinstance(v, pcbnew.PCB_VIA)]
            assert len(vias) == 20 and len(new) == 20, "%d vias were placed, not ten a side; %s" % (len(vias), said[-1:])
            assert all(v.GetNetname() == "GND" and mm(v.GetWidth(pcbnew.F_Cu)) == 0.6 and mm(v.GetDrillValue()) == 0.3 for v in vias), "the vias are not 0.6/0.3 mm on GND"
            for side in (X - 1.2, X + 1.2):
                ys = sorted(mm(v.GetPosition().y) for v in vias if abs(mm(v.GetPosition().x) - side) < 1e-3)
                assert len(ys) == 10 and abs(ys[0] - Y0) < 1e-3 and abs(ys[-1] - Y1) < 1e-3, "the row at x = %.2f has %d vias from %s" % (side, len(ys), ys[:1])
                steps = [b - a for a, b in zip(ys, ys[1:])]
                assert max(steps) - min(steps) < 0.002 and 1.5 <= steps[0] < 1.52, "the row's pitch is %.3f to %.3f mm" % (min(steps), max(steps))
            return {"vias": len(vias), "pitch_mm": round(steps[0], 3)}
        zones = [z for z in new if isinstance(z, pcbnew.ZONE)]
        assert len(zones) == 1 and len(new) == 1, "the clearance is not one zone: %s; %s" % ([type(i).__name__ for i in new], said[-1:])
        z = zones[0]
        assert z.GetIsRuleArea() and z.GetDoNotAllowCopperPour() and z.GetLayer() == pcbnew.B_Cu, "the zone is not a copper pour keep-out on the track's layer"
        o = z.Outline().Outline(0)
        far = []
        for i in range(o.PointCount()):
            x, y = mm(o.CPoint(i).x), mm(o.CPoint(i).y)
            d = math.hypot(x - X, y - min(max(y, Y0), Y1))
            if abs(d - 0.8) > 0.005:
                far.append((round(x, 3), round(y, 3), round(d, 3)))
        assert o.PointCount() >= 20 and not far, "%d of %d corners are not 0.4 mm from the track's copper: %s" % (len(far), o.PointCount(), far[:3])
        return {"corners": o.PointCount()}
    finally:
        seen.clear()
        seen["ids"] = _ids()
        if "Rounder" in action or "Solder" in action or "Tapers" in action or "Measure" in action or "Via Fence" in action:
            _pick(_straight())
