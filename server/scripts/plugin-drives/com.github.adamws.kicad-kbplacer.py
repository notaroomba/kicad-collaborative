# board: server/scripts/plugin-drives/boards/keyboard-2x2.kicad_pcb
# pick: server/scripts/plugin-drives/boards/keyboard-2x2.json
"""kbplacer: a board with four switches and four diodes scattered about, and a 2 by 2 keyboard layout picked with
Browse.  Expect the switches on a 19.05 mm grid in layout order, each diode at the default offset from its switch
(5.08, 4 mm, turned 90 degrees), tracks joining each switch to its diode, and the rows and columns routed pad to
pad except where two of them would cross."""
import pcbnew
import wx

from drive_util import messages, find_all, label_of

seen = {}
REFS = ["SW1", "SW2", "SW3", "SW4", "D1", "D2", "D3", "D4"]


def _at(ref):
    p = pcbnew.GetBoard().FindFootprintByReference(ref).GetPosition()
    return round(pcbnew.ToMM(p.x), 3), round(pcbnew.ToMM(p.y), 3)


def modal(dlg):
    name = type(dlg).__name__
    if name == "KbplacerDialog":
        seen["start"] = {r: _at(r) for r in REFS}
        seen["tracks_before"] = len(list(pcbnew.GetBoard().GetTracks()))
        browse = [w for w in find_all(wx.Button, root=dlg) if label_of(w) == "Browse"][0]
        browse.GetEventHandler().ProcessEvent(wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED, browse.GetId()))
        seen["layout"] = dlg.get_layout_path_or_url()
        return wx.ID_OK
    seen.setdefault("other", []).append(name + ": " + " | ".join([label_of(w) for w in find_all(wx.StaticText, root=dlg)] + [str(w.GetValue()) for w in find_all(wx.TextCtrl, root=dlg)])[-1500:])
    return None


def after_run(_action):
    assert seen.get("layout", "").endswith("keyboard-2x2.json"), "Browse did not bring the layout file: %s; %s" % (seen, messages())
    assert not seen.get("other"), "unexpected windows: %s" % seen["other"]
    x0, y0 = _at("SW1")
    want = {"SW1": (0, 0), "SW2": (19.05, 0), "SW3": (0, 19.05), "SW4": (19.05, 19.05)}
    for ref, (dx, dy) in want.items():
        x, y = _at(ref)
        assert abs(x - x0 - dx) < 0.01 and abs(y - y0 - dy) < 0.01, "%s is %.3f, %.3f mm from SW1, not %s, %s" % (ref, x - x0, y - y0, dx, dy)
    assert _at("SW2") != seen["start"]["SW2"], "the switches did not move"
    board = pcbnew.GetBoard()
    for i in range(1, 5):
        sx, sy = _at("SW%d" % i)
        dx, dy = _at("D%d" % i)
        assert abs(dx - sx - 5.08) < 0.01 and abs(dy - sy - 4.0) < 0.01, "D%d is %.3f, %.3f mm from its switch, not 5.08, 4" % (i, dx - sx, dy - sy)
        turn = board.FindFootprintByReference("D%d" % i).GetOrientationDegrees() % 360
        assert abs(turn - 90) < 0.01, "D%d is turned %s degrees, not 90" % (i, turn)
    tracks = list(board.GetTracks())
    assert len(tracks) > seen["tracks_before"], "no tracks were drawn"
    nets = sorted({t.GetNetname() for t in tracks})
    for i in range(1, 5):
        assert "Net-(D%d-A)" % i in nets, "switch %d is not routed to its diode: %s" % (i, nets)
    # rows and columns: a straight track between the two pads of the net.  ROW0 (between the diodes of the top row)
    # and COL1 (between the right-hand switches) would cross on the same layer at 53.34, 43.75 mm from the layout's
    # origin, so the plugin lays whichever of the two it reaches first and refuses the other, as it does on a desktop.
    mm = lambda v: (round(pcbnew.ToMM(v.x), 3), round(pcbnew.ToMM(v.y), 3))
    pads = {}
    for f in board.GetFootprints():
        for p in f.Pads():
            pads.setdefault(p.GetNetname(), []).append(mm(p.GetPosition()))
    lines = {}
    for t in tracks:
        lines.setdefault(t.GetNetname(), []).append({mm(t.GetStart()), mm(t.GetEnd())})
    joined = {net: lines.get(net) == [set(pads[net])] for net in ("ROW0", "ROW1", "COL0", "COL1")}
    assert joined["ROW1"] and joined["COL0"], "rows and columns are not routed pad to pad: %s" % {n: lines.get(n) for n in joined}
    assert joined["ROW0"] != joined["COL1"], "ROW0 and COL1 cross, so exactly one of them is laid: %s" % joined
    assert len(tracks) == seen["tracks_before"] + 11, "%d tracks were drawn, not 11" % (len(tracks) - seen["tracks_before"])
    return {"placed": {r: _at(r) for r in REFS}, "tracks": len(tracks), "nets": nets, "rows and columns": joined}
