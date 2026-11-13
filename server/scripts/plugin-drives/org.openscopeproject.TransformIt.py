# board: server/scripts/plugin-drives/boards/three-tracks.kicad_pcb
# select: 11111111-0000-4000-8000-000000000001,11111111-0000-4000-8000-000000000002,11111111-0000-4000-8000-000000000003
"""Transform It: three selected tracks, scaled to 200 % both ways, turned 90 degrees, track width 150 %.  The
transform is about the middle of the selection, (120, 120) here.  Expect every track end where that arithmetic puts
it and the tracks 0.375 mm wide."""
import pcbnew
import wx

seen = {}
# (x - 120, y - 120) doubled, then turned: x' = -y, y' = x
WANT = sorted([((160.0, 80.0), (160.0, 120.0)), ((160.0, 120.0), (120.0, 120.0)), ((120.0, 120.0), (80.0, 160.0))])


def modal(dlg):
    name = type(dlg).__name__
    if name != "ConfigDialog":
        seen["trouble"] = name
        return wx.ID_CANCEL
    dlg.m_horizontalScale.SetValue(200)
    dlg.m_verticalScale.SetValue(200)
    dlg.m_rotation.SetValue(90)
    dlg.m_trackWidth.SetValue(150)
    cfg = dlg.GetConfig()
    assert abs(cfg.x_scale - 2) < 1e-9 and abs(cfg.y_scale - 2) < 1e-9 and abs(cfg.track_width - 1.5) < 1e-9, cfg
    return wx.ID_OK


def after_run(action):
    assert "trouble" not in seen, seen
    got = sorted(((round(pcbnew.ToMM(t.GetStart().x), 3), round(pcbnew.ToMM(t.GetStart().y), 3)), (round(pcbnew.ToMM(t.GetEnd().x), 3), round(pcbnew.ToMM(t.GetEnd().y), 3)))
                 for t in pcbnew.GetBoard().GetTracks())
    assert len(got) == 3, got
    for g, w in zip(got, WANT):
        assert all(abs(a - b) < 0.002 for p, q in zip(g, w) for a, b in zip(p, q)), f"the tracks are at {got}, expected {WANT}"
    widths = sorted({round(pcbnew.ToMM(t.GetWidth()), 4) for t in pcbnew.GetBoard().GetTracks()})
    assert widths == [0.375], widths
    return {"tracks": got, "width": widths[0]}
