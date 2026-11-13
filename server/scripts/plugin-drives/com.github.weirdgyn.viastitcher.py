# select: 00000000-0000-0000-0000-00004eed97a2
"""ViaStitcher: with the board's GND zone selected, ask for a 4 mm grid of 1.2 / 0.6 mm vias and press Ok; expect GND vias
on that grid, every one over the zone's filled copper and none on a pad of another net."""
import pcbnew
import wx
from drive_util import windows, click, messages


def _vias():
    return [t for t in pcbnew.GetBoard().GetTracks() if isinstance(t, pcbnew.PCB_VIA)]


def after_run(_action):
    dlg = [w for w in windows() if type(w).__name__ == "ViaStitcherDialog"]
    assert dlg, "the ViaStitcher window never opened: %s" % messages()[-2:]
    dlg = dlg[0]
    before = {v.m_Uuid.AsString() for v in _vias()}
    dlg.m_txtHSpacing.SetValue("4")
    dlg.m_txtVSpacing.SetValue("4")
    click("Ok", dlg)
    new = [v for v in _vias() if v.m_Uuid.AsString() not in before]
    assert len(new) >= 10, "only %d vias were placed; the plugin said: %s" % (len(new), messages()[-2:])
    board = pcbnew.GetBoard()
    zone = [z for z in board.Zones() if z.GetNetname() == "GND"][0]
    assert all(v.GetNetname() == "GND" for v in new), "vias on other nets: %s" % sorted({v.GetNetname() for v in new})
    assert all(pcbnew.ToMM(v.GetWidth(pcbnew.F_Cu)) == 1.2 and pcbnew.ToMM(v.GetDrill()) == 0.6 for v in new), "the vias are not 1.2 / 0.6 mm"
    outside = [v for v in new if not zone.HitTestFilledArea(pcbnew.B_Cu, v.GetPosition(), 0)]
    assert not outside, "%d of %d vias are not over the zone's filled copper" % (len(outside), len(new))
    xs = sorted({v.GetPosition().x for v in new})
    steps = {b - a for a, b in zip(xs, xs[1:])}
    assert all(s % pcbnew.FromMM(4) == 0 for s in steps), "the vias are not on a 4 mm grid: steps %s" % sorted(pcbnew.ToMM(s) for s in steps)[:5]
    hits = []
    for v in new:
        for p in board.GetPads():
            if p.GetNetname() != "GND" and p.HitTest(v.GetPosition(), v.GetWidth(pcbnew.F_Cu) // 2):
                hits.append((p.GetParentFootprint().GetReference(), str(p.GetNumber())))
    assert not hits, "vias were placed on pads of other nets: %s" % hits[:5]
    return {"vias": len(new), "said": messages()[-1:]}
