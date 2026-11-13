# board: server/scripts/plugin-drives/boards/three-tracks.kicad_pcb
"""Round Tracks on the barest board there is: three tracks in a row with no nets, no footprints and no schematic,
meeting at a right angle and then at 135 degrees.  Press Run with native fillets and expect an arc at each corner:
it starts on one track and ends on the next, touches both tangentially, and the tracks are cut back to meet it.
Press Unround and expect the three tracks back where they were.  Then Run again without native fillets and expect
each corner cut into short straight pieces that stay inside the corner."""
import math

import pcbnew
import wx

from drive_util import label_of, find_all

seen = {"said": [], "step": "round"}
CORNERS = [(120.0, 100.0), (120.0, 120.0)]
ENDS = [(100.0, 100.0), (140.0, 140.0)]


def _mm(p):
    return (round(pcbnew.ToMM(p.x), 4), round(pcbnew.ToMM(p.y), 4))


def _tracks():
    segs, arcs = [], []
    for t in pcbnew.GetBoard().GetTracks():
        if t.GetClass() == "PCB_ARC":
            arcs.append((_mm(t.GetStart()), _mm(t.GetMid()), _mm(t.GetEnd())))
        elif t.GetClass() == "PCB_TRACK":
            segs.append((_mm(t.GetStart()), _mm(t.GetEnd())))
    return segs, arcs


def _near(a, b, tol=0.01):
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol


def _on(p, a, b, tol=0.01):
    """p lies on the straight piece from a to b."""
    d = math.hypot(b[0] - a[0], b[1] - a[1])
    if d < 1e-9:
        return _near(p, a, tol)
    off = abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / d
    along = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (d * d)
    return off <= tol and -1e-3 <= along <= 1 + 1e-3


def _centre(s, m, e):
    ax, ay, bx, by, cx, cy = *s, *m, *e
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return ux, uy


ORIGINAL = [((100.0, 100.0), (120.0, 100.0)), ((120.0, 100.0), (120.0, 120.0)), ((120.0, 120.0), (140.0, 140.0))]


def modal(dlg):
    name = type(dlg).__name__
    if name != "RoundTracks":
        seen["said"].append(name + ": " + " | ".join(label_of(w) for w in find_all(wx.StaticText, root=dlg))[:300])
        return wx.ID_OK
    press = wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED)
    if seen["step"] == "round":
        assert dlg.netclasslist.GetItemCount() >= 1 and dlg.netclasslist.GetTextValue(0, 0) == "Default", "the net class list has no Default row"
        dlg.use_native.SetValue(True)
        dlg.netclasslist.SetTextValue("3", 0, 2)            # a 3 mm radius
        dlg.run(press)
    elif seen["step"] == "unround":
        dlg.unrun(press)
    else:
        dlg.use_native.SetValue(False)
        dlg.netclasslist.SetTextValue("3", 0, 2)
        dlg.netclasslist.SetTextValue("2", 0, 3)            # two passes
        dlg.run(press)
    return dlg.GetReturnCode() or wx.ID_OK


def _check_round():
    segs, arcs = _tracks()
    assert len(arcs) == 2, f"expected an arc at each of the two corners, the board has {len(arcs)}: {arcs}"
    assert len(segs) == 3, f"expected the three tracks kept (cut back), the board has {len(segs)}: {segs}"
    for corner, (a, b) in zip(CORNERS, [(ORIGINAL[0], ORIGINAL[1]), (ORIGINAL[1], ORIGINAL[2])]):
        arc = min(arcs, key=lambda k: math.hypot(k[1][0] - corner[0], k[1][1] - corner[1]))
        s, m, e = arc
        ends = [s, e]
        on_a = [p for p in ends if _on(p, *a)]
        on_b = [p for p in ends if _on(p, *b)]
        assert len(on_a) == 1 and len(on_b) == 1 and on_a[0] != on_b[0], f"the arc at {corner} does not run from one track to the next: {arc}"
        # cut back by the same length on both sides, and by something
        da, db = math.hypot(on_a[0][0] - corner[0], on_a[0][1] - corner[1]), math.hypot(on_b[0][0] - corner[0], on_b[0][1] - corner[1])
        assert 0.5 < da < 10 and abs(da - db) < 0.02, f"the arc at {corner} leaves the tracks {da:.3f} and {db:.3f} mm from the corner"
        # tangent to both: the radius at each end is square to the track
        cx, cy = _centre(s, m, e)
        for p, (t0, t1) in ((on_a[0], a), (on_b[0], b)):
            dot = (p[0] - cx) * (t1[0] - t0[0]) + (p[1] - cy) * (t1[1] - t0[1])
            r = math.hypot(p[0] - cx, p[1] - cy)
            assert abs(dot) / (r * math.hypot(t1[0] - t0[0], t1[1] - t0[1])) < 0.01, f"the arc at {corner} meets a track at an angle"
        # the arc bulges towards the corner it replaces, and the middle is nearer to it than the ends
        assert math.hypot(m[0] - corner[0], m[1] - corner[1]) < da, f"the arc at {corner} bends away from the corner"
        # the tracks now end where the arc starts
        assert any(_near(on_a[0], p) for sg in segs for p in sg) and any(_near(on_b[0], p) for sg in segs for p in sg), f"the tracks were not cut back to the arc at {corner}: {segs}"
    for end in ENDS:
        assert any(_near(end, p) for sg in segs for p in sg), f"the far end {end} moved: {segs}"
    return {"arcs": [[list(p) for p in a] for a in arcs]}


def _check_unround():
    segs, arcs = _tracks()
    assert not arcs, f"arcs are left after Unround: {arcs}"
    assert len(segs) == 3, segs
    for a, b in ORIGINAL:
        assert any((_near(a, s, 0.02) and _near(b, e, 0.02)) or (_near(a, e, 0.02) and _near(b, s, 0.02)) for s, e in segs), f"track {a} to {b} is not back: {segs}"
    return {"segments": len(segs)}


def _check_subdivide():
    segs, arcs = _tracks()
    assert not arcs, arcs
    assert len(segs) > 3, f"the corners were not cut into pieces: {segs}"
    pts = {p for sg in segs for p in sg}
    for corner in CORNERS:
        assert not any(_near(corner, p, 0.05) for p in pts), f"a track still reaches the sharp corner {corner}"
    for end in ENDS:
        assert any(_near(end, p) for p in pts), f"the far end {end} moved"
    # still one path from end to end: every other point is shared by exactly two pieces
    count = {}
    for sg in segs:
        for p in sg:
            k = (round(p[0], 2), round(p[1], 2))
            count[k] = count.get(k, 0) + 1
    loose = [k for k, n in count.items() if n != 2 and not any(_near(k, e, 0.02) for e in ENDS)]
    assert not loose, f"the path is broken at {loose}"
    # every piece stays inside the bend: no point beyond the original corner
    assert all(100 - 0.01 <= p[0] <= 140.01 and 100 - 0.01 <= p[1] <= 140.01 for p in pts), pts
    return {"pieces": len(segs)}


def after_run(action):
    out = {"round": _check_round()}
    seen["step"] = "unround"
    import kicad_web
    kicad_web._actions[0].Run()
    out["unround"] = _check_unround()
    seen["step"] = "subdivide"
    kicad_web._actions[0].Run()
    out["subdivide"] = _check_subdivide()
    out["said"] = seen["said"][:4]
    return out
