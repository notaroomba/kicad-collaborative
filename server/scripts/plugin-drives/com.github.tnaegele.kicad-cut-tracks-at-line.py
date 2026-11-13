# insert: (gr_line (start 150 103) (end 160 103) (stroke (width 0.1) (type default)) (layer "Cmts.User") (uuid "7c1f0d2e-3a4b-4c5d-8e6f-0a1b2c3d4e5f"))
# select: 7c1f0d2e-3a4b-4c5d-8e6f-0a1b2c3d4e5f,d7a2ea41-4fea-4c56-89ef-27fec710c0ad
"""Cut tracks at line: a drawn line crossing one vertical track at y = 103 mm is selected together with that track; expect
the track cut in two at the crossing, both halves on the same net, layer and width, and together the old length."""
import pcbnew


def after_run(_action):
    board = pcbnew.GetBoard()
    x = pcbnew.FromMM(156.21)
    on_line = [t for t in board.GetTracks() if not isinstance(t, pcbnew.PCB_VIA)
               and t.GetStart().x == x and t.GetEnd().x == x
               and min(t.GetStart().y, t.GetEnd().y) >= pcbnew.FromMM(95.885) and max(t.GetStart().y, t.GetEnd().y) <= pcbnew.FromMM(110.5)]
    assert len(on_line) == 2, "the track was not cut: %d pieces where there should be two" % len(on_line)
    a, b = sorted(on_line, key=lambda t: min(t.GetStart().y, t.GetEnd().y))
    cut = pcbnew.FromMM(103)
    assert max(a.GetStart().y, a.GetEnd().y) == cut and min(b.GetStart().y, b.GetEnd().y) == cut, "the pieces do not meet at y = 103 mm"
    assert a.GetLength() + b.GetLength() == pcbnew.FromMM(110.5) - pcbnew.FromMM(95.885), "the two pieces are not the old track's length"
    assert a.GetNetname() == b.GetNetname() and a.GetNetname(), "the new piece lost its net: %r and %r" % (a.GetNetname(), b.GetNetname())
    assert a.GetLayer() == b.GetLayer() and a.GetWidth() == b.GetWidth(), "the new piece changed layer or width"
    return {"pieces": [round(pcbnew.ToMM(a.GetLength()), 3), round(pcbnew.ToMM(b.GetLength()), 3)], "net": a.GetNetname()}
