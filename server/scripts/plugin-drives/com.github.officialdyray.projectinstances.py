# board: demos/complex_hierarchy/complex_hierarchy.kicad_pcb
# sibling: server/scripts/plugin-drives/boards/ampli_ht.kicad_pcb
"""ProjectInstances: the project holds ampli_ht.kicad_pcb, a layout for the sheet ampli_ht.kicad_sch that the root
schematic places twice.  Tick the sub-board in the tree (which ticks both instances) and Apply.  Expect, for each
instance, every footprint at the place the sub-board gives it relative to the anchor footprint (which stays put),
the sub-board's two tracks and its via copied beside them, and everything gathered in a group named after the sheet."""
import math

import pcbnew
import wx

from drive_util import messages

SHEETS = ("00000000-0000-0000-0000-00004b3a1333", "00000000-0000-0000-0000-00004b3a13a4")
seen = {}


def _by_path():
    return {fp.GetPath().AsString(): fp for fp in pcbnew.GetBoard().GetFootprints()}


def _pose(fp):
    p = fp.GetPosition()
    return p.x, p.y, fp.GetOrientationDegrees()


def modal(dlg):
    name = type(dlg).__name__
    if name == "DlgHPCBRun":
        tree = dlg.treeApplyTo
        tops = tree.GetRootItem().GetChildren()
        seen["rooms"] = [(i.GetText(), tree.GetItemData(i).selectedAnchor if tree.GetItemData(i).isValid else None) for i in tops]
        seen["before"] = {k: _pose(fp) for k, fp in _by_path().items()}
        seen["refs"] = {k: fp.GetReference() for k, fp in _by_path().items()}
        seen["tracks_before"] = len(list(pcbnew.GetBoard().GetTracks()))
        item = [i for i in tops if i.GetText() == "ampli_ht.kicad_pcb"][0]
        seen["instances"] = sorted(c.GetText() for c in item.GetChildren())
        tree._wx_ticked(item._node)            # the person ticks the sub-board's box
        seen["boxes"] = [tree.GetCheckedState(c) for c in item.GetChildren()]
        tree.Select(item)
        seen["anchors"] = dlg.anchorChoice.GetCount()
        seen["checked"] = sorted("/" + i._uuid for i in tree.GetItemData(item)._instances if i.enabled)
        dlg.handleApply(wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED))
        return dlg.GetReturnCode() or wx.ID_OK
    seen.setdefault("other", []).append(name)
    return None


def after_run(_action):
    assert seen.get("boxes") == [wx.CHK_CHECKED, wx.CHK_CHECKED], "ticking the sub-board did not tick its instances: %s" % seen.get("boxes")
    assert seen.get("anchors") == 29, "selecting the sub-board listed %s anchors, not its 29 footprints" % seen.get("anchors")
    assert not seen.get("other"), "unexpected windows: %s; %s" % (seen["other"], messages())
    assert "ampli_ht.kicad_pcb" in [r[0] for r in seen.get("rooms", [])], "the sub-board was not found: %s" % seen.get("rooms")
    assert seen["checked"] == ["/" + s for s in SHEETS], "the two instances (%s) were not ticked: %s" % (seen.get("instances"), seen["checked"])
    anchor_ref = dict(seen["rooms"])["ampli_ht.kicad_pcb"]
    sub = pcbnew.LoadBoard("/project/ampli_ht.kicad_pcb")
    subs = {fp.GetPath().AsString(): fp for fp in sub.GetFootprints()}
    assert len(subs) == 29
    anchor = [fp for fp in subs.values() if fp.GetReference() == anchor_ref][0]
    ax, ay, arot = _pose(anchor)
    board = pcbnew.GetBoard()
    now = _by_path()
    moved = 0
    report = {}
    for sheet in SHEETS:
        key = "/" + sheet + anchor.GetPath().AsString()
        tx, ty, trot = seen["before"][key]
        assert _pose(now[key]) == (tx, ty, trot), "the anchor of sheet %s moved" % sheet
        turn = math.radians(trot - arot)

        def place(x, y):
            dx, dy = x - ax, y - ay
            return (dy * math.sin(turn) + dx * math.cos(turn) + tx, dy * math.cos(turn) - dx * math.sin(turn) + ty)

        for path, fp in subs.items():
            target = now["/" + sheet + path]
            x, y, rot = _pose(target)
            ex, ey = place(fp.GetPosition().x, fp.GetPosition().y)
            assert abs(x - ex) <= 2 and abs(y - ey) <= 2, "%s is at %.3f, %.3f mm, not %.3f, %.3f" % (
                target.GetReference(), pcbnew.ToMM(x), pcbnew.ToMM(y), pcbnew.ToMM(ex), pcbnew.ToMM(ey))
            want = (fp.GetOrientationDegrees() - arot + trot) % 360
            assert abs((rot - want + 180) % 360 - 180) < 0.01, "%s is turned %s, not %s" % (target.GetReference(), rot, want)
            moved += _pose(target) != seen["before"]["/" + sheet + path]
            # the plugin swaps the footprint's fields for copies of the sub-board's, keeping the reference
            assert target.GetReference() == seen["refs"]["/" + sheet + path], "%s lost its reference" % seen["refs"]["/" + sheet + path]
            assert target.GetValue() == fp.GetValue(), "%s has value %r, not %r" % (target.GetReference(), target.GetValue(), fp.GetValue())
            names = sorted(f.GetName() for f in target.GetFields())
            assert names == sorted(f.GetName() for f in fp.GetFields()), "%s has fields %s" % (target.GetReference(), names)
            rp, sp = target.Reference().GetPosition(), fp.Reference().GetPosition()
            ex, ey = place(sp.x, sp.y)
            assert abs(rp.x - ex) <= 2 and abs(rp.y - ey) <= 2, "the reference text of %s is at %.3f, %.3f mm, not %.3f, %.3f" % (
                target.GetReference(), pcbnew.ToMM(rp.x), pcbnew.ToMM(rp.y), pcbnew.ToMM(ex), pcbnew.ToMM(ey))
        # the sub-board's copper, carried over
        ends = lambda t: tuple(sorted([(t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y)]))
        near = lambda a, b: all(abs(p - q) <= 2 for pa, pb in zip(a, b) for p, q in zip(pa, pb))
        tracks = list(board.GetTracks())
        for t in sub.GetTracks():
            s, e = place(t.GetStart().x, t.GetStart().y), place(t.GetEnd().x, t.GetEnd().y)
            want = tuple(sorted([s, e]))
            hits = [k for k in tracks if type(k).__name__ == type(t).__name__ and near(ends(k), want) and k.GetLayer() == t.GetLayer() and k.GetWidth() == t.GetWidth()]
            assert hits, "a %s of the sub-board was not copied for sheet %s" % (type(t).__name__, sheet)
        report[sheet[-4:]] = [round(pcbnew.ToMM(v), 3) for v in (tx, ty)]
    assert moved >= 50, "only %d footprints moved" % moved
    assert len(list(board.GetTracks())) == seen["tracks_before"] + 6, "tracks went from %d to %d, not 6 more" % (seen["tracks_before"], len(list(board.GetTracks())))
    groups = {g.GetName(): len(list(g.GetItems())) for g in board.Groups()}
    made = {n: c for n, c in groups.items() if n in SHEETS}
    assert len(made) == 2 and all(c == 32 for c in made.values()), "the two groups of 29 footprints and 3 tracks are not there: %s" % groups
    return {"anchor": anchor_ref, "moved": moved, "groups": made, "anchors_at": report}
