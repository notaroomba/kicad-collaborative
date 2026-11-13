# board: server/scripts/plugin-drives/boards/three-tracks.kicad_pcb
"""Space-Filling Curve: a Hilbert curve of order 2 as tracks, in a 40 mm square, 0.3 mm wide.  Expect 15 new track
pieces (an order 2 curve visits 16 points) that form one unbroken path, each piece 10 mm long and straight along
x or y, every one of the 16 cells of the square visited once, all in one group, and the board's own three tracks
untouched."""
import pcbnew
import wx

OWN = {((100.0, 100.0), (120.0, 100.0)), ((120.0, 100.0), (120.0, 120.0)), ((120.0, 120.0), (140.0, 140.0))}


def _set(dlg, widget, value, handler, kind):
    getattr(widget, "SetSelection" if kind == "choice" else "SetValue")(value)
    ev = wx.CommandEvent(wx.wxEVT_COMBOBOX if kind == "choice" else wx.wxEVT_TEXT, widget.GetId())
    ev.SetEventObject(widget)
    handler(ev)


def after_run(action):
    from drive_util import windows
    hits = [w for w in windows() if type(w).__name__ == "SpaceFillingCurveInterface"]
    assert len(hits) == 1, f"the plugin's window is not open: {[type(w).__name__ for w in windows()]}"
    dlg = hits[0]
    _set(dlg, dlg.type_combo, 0, dlg.OnTypeChanged, "choice")       # Hilbert
    _set(dlg, dlg.shape_combo, 0, dlg.OnShapeChanged, "choice")     # Square
    _set(dlg, dlg.curve_combo, 0, dlg.OnCurveChanged, "choice")     # Track
    _set(dlg, dlg.order_spin, 2, dlg.OnOrderChanged, "value")
    _set(dlg, dlg.width_spin, 0.3, dlg.OnWidthChanged, "value")
    _set(dlg, dlg.size_spin, 40, dlg.OnSizeChanged, "value")
    dlg.OnOK(wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED))
    board = pcbnew.GetBoard()
    mm = lambda p: (round(pcbnew.ToMM(p.x), 3), round(pcbnew.ToMM(p.y), 3))
    tracks = [(mm(t.GetStart()), mm(t.GetEnd()), round(pcbnew.ToMM(t.GetWidth()), 4)) for t in board.GetTracks()]
    own = [t for t in tracks if (t[0], t[1]) in OWN]
    new = [t for t in tracks if (t[0], t[1]) not in OWN]
    assert len(own) == 3, f"the board's own tracks changed: {tracks[:6]}"
    assert len(new) == 15, f"{len(new)} new tracks, an order 2 curve has 15 pieces"
    assert {t[2] for t in new} == {0.3}, {t[2] for t in new}
    # one unbroken path in drawing order, each piece 10 mm along one axis
    for i, (s, e, _) in enumerate(new):
        dx, dy = abs(e[0] - s[0]), abs(e[1] - s[1])
        assert sorted((dx, dy)) == [0, 10.0], f"piece {i} runs from {s} to {e}"
        if i:
            assert new[i - 1][1] == s, f"the path breaks between piece {i - 1} and {i}"
    points = [new[0][0]] + [t[1] for t in new]
    assert len(set(points)) == 16, "the curve crosses itself"
    xs, ys = sorted({p[0] for p in points}), sorted({p[1] for p in points})
    assert len(xs) == 4 and len(ys) == 4 and xs[-1] - xs[0] == 30.0 and ys[-1] - ys[0] == 30.0, (xs, ys)
    # a Hilbert curve starts and ends on the same side of the square, three cells apart
    a, b = points[0], points[-1]
    assert (a[0] == b[0] and abs(a[1] - b[1]) == 30.0) or (a[1] == b[1] and abs(a[0] - b[0]) == 30.0), (a, b)
    groups = [g for g in board.Groups()]
    assert len(groups) == 1 and len(list(groups[0].GetItems())) == 15, [len(list(g.GetItems())) for g in groups]
    return {"pieces": len(new), "from": list(a), "to": list(b), "grouped": 15}
