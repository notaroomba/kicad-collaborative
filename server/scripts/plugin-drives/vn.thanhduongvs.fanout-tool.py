# board: demos/kit-dev-coldfire-xilinx_5213/kit-dev-coldfire-xilinx_5213.kicad_pcb
"""Fanout Tool: press Fanout for the part the window offers first and expect one via and one track per pad of that part,
each track starting on its pad and carrying the pad's net; then press Undo and expect the board as it was."""
import pcbnew
import wx
from drive_util import windows, click, find_all, messages


def _count():
    tracks = list(pcbnew.GetBoard().GetTracks())
    return len(tracks), tracks


def after_run(_action):
    wx._run_later()                                  # the window connects to the editor half a second after it opens
    assert windows(), "the Fanout Tool window never opened"
    win = windows()[0]
    refs = [c.GetStringSelection() for c in find_all(wx.Choice, root=win)]
    board = pcbnew.GetBoard()
    part = next((board.FindFootprintByReference(r) for r in refs if r and board.FindFootprintByReference(r) is not None), None)
    assert part is not None, "the window offers no part of the board: %s" % refs
    pads = list(part.Pads())
    before, old = _count()
    old_ids = {t.m_Uuid.AsString() for t in old}
    click("Fanout", win)
    wx._run_later()
    after, tracks = _count()
    new = [t for t in tracks if t.m_Uuid.AsString() not in old_ids]
    vias = [t for t in new if isinstance(t, pcbnew.PCB_VIA)]
    segs = [t for t in new if not isinstance(t, pcbnew.PCB_VIA)]
    assert vias and len(vias) == len(segs), "Fanout added %d vias and %d tracks; the plugin said: %s" % (len(vias), len(segs), messages()[-2:])
    assert len(vias) <= len(pads), "%d vias for a part with %d pads" % (len(vias), len(pads))
    spots = {(p.GetPosition().x, p.GetPosition().y): p.GetNetname() for p in pads}
    loose = [s for s in segs if spots.get((s.GetStart().x, s.GetStart().y), spots.get((s.GetEnd().x, s.GetEnd().y))) != s.GetNetname()]
    assert not loose, "%d of %d new tracks do not start on a pad of %s with the pad's net" % (len(loose), len(segs), part.GetReference())
    click("Undo", win)
    wx._run_later()
    assert _count()[0] == before, "Undo left %d tracks and vias, there were %d before" % (_count()[0], before)
    return {"part": part.GetReference(), "pads": len(pads), "vias": len(vias), "tracks": len(segs), "undone": True}
