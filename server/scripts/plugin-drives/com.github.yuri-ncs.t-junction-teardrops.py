# board: server/scripts/plugin-drives/boards/t-junction.kicad_pcb
"""T-Junction Teardrops: one net, a 0.4 mm track with a branch leaving it at a right angle at (120, 100).  Press
Apply and expect two small copper zones named T-td on that net and layer, one in each corner of the T (left and
right of the branch, on the branch's side of the main track), each reaching about a millimetre along both tracks
and none on the far side of the main track.  Run again in Remove mode and expect them gone, the tracks as before."""
import pcbnew
import wx

seen = {"step": "add", "windows": []}


def modal(dlg):
    name = type(dlg).__name__
    seen["windows"].append(name)
    if name != "TeardropDialog":
        return wx.ID_OK
    dlg.mode.SetSelection(0 if seen["step"] == "add" else 1)
    dlg.objects.SetSelection(0)
    dlg.on_change()
    seen["count_" + seen["step"]] = dlg.count.GetLabel()
    dlg.on_apply()
    return dlg.GetReturnCode() or wx.ID_OK


def _wedges():
    out = []
    for z in pcbnew.GetBoard().Zones():
        if z.GetZoneName() != "T-td":
            continue
        o = z.Outline().Outline(0)
        pts = [(pcbnew.ToMM(o.CPoint(i).x), pcbnew.ToMM(o.CPoint(i).y)) for i in range(o.PointCount())]
        out.append({"net": z.GetNetname(), "layer": z.GetLayer(), "pts": pts})
    return out


def _tracks():
    return sorted(((pcbnew.ToMM(t.GetStart().x), pcbnew.ToMM(t.GetStart().y)), (pcbnew.ToMM(t.GetEnd().x), pcbnew.ToMM(t.GetEnd().y)), pcbnew.ToMM(t.GetWidth())) for t in pcbnew.GetBoard().GetTracks())


def after_run(action):
    tracks = _tracks()
    w = _wedges()
    assert len(w) == 2, f"expected a wedge in each corner of the T, the board has {len(w)}: {w}"
    sides = []
    for z in w:
        assert z["net"] == "SIG" and z["layer"] == pcbnew.F_Cu, (z["net"], z["layer"])
        xs, ys = [p[0] for p in z["pts"]], [p[1] for p in z["pts"]]
        assert len(z["pts"]) >= 3
        # on the branch's side of the main track (the track's edge is at y = 100.2), never past its far edge
        assert min(ys) > 99.8 - 1e-6, f"a wedge reaches across the main track: {z['pts']}"
        # it reaches along the main track and down the branch by about the default length (1 mm at most)
        assert 0.3 < max(ys) - 100.2 <= 1.05, f"the wedge runs {max(ys) - 100.2:.3f} mm down the branch"
        left = max(xs) <= 120.0 + 1e-6
        right = min(xs) >= 120.0 - 1e-6
        assert left != right, f"a wedge straddles the branch: {z['pts']}"
        reach = (119.8 - min(xs)) if left else (max(xs) - 120.2)
        assert 0.3 < reach <= 1.05, f"the wedge runs {reach:.3f} mm along the main track"
        sides.append("left" if left else "right")
    assert sorted(sides) == ["left", "right"], sides
    seen["step"] = "remove"
    import kicad_web
    kicad_web._actions[0].Run()
    assert not _wedges(), f"wedges are left after Remove: {_wedges()}"
    assert _tracks() == tracks and len(tracks) == 3, "the tracks changed"
    return {"wedges": 2, "sides": sorted(sides), "said": [seen.get("count_add"), seen.get("count_remove")]}
