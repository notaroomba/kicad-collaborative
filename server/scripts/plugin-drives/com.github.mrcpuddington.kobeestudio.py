"""Kobee Studio: type a label, press Place artwork, and expect one new footprint on the board that holds the
label's outlines and is handed to the cursor to be placed.  The plugin builds the footprint through KiCad's IPC interface (kicad-python)."""
import pcbnew
import wx

from drive_util import click, messages, walk

seen = {}


def modal(dlg):
    if type(dlg).__name__ != "MainDialog":
        return None
    box = [w for w in walk(dlg) if type(w).__name__ == "StyledTextCtrl"][0]
    if "typed" not in seen:
        seen["typed"] = True
        seen["before"] = {f.m_Uuid.AsString() for f in pcbnew.GetBoard().GetFootprints()}
        box.SetValue("HELLO")
    elif "edited" not in seen:
        # opened again with the artwork selected: the window holds what was placed, and placing replaces it
        seen["edited"] = True
        seen["loaded"] = box.GetValue()
        box.SetValue("HI")
        click("Update artwork", root=dlg)
        return dlg.GetReturnCode() or wx.ID_OK
    else:
        return None
    click("Place artwork", root=dlg)
    return dlg.GetReturnCode() or wx.ID_OK


def after_run(_action):
    assert seen.get("typed"), "Kobee Studio's window never opened"
    new = [f for f in pcbnew.GetBoard().GetFootprints() if f.m_Uuid.AsString() not in seen["before"]]
    assert len(new) == 1, "expected one new footprint, found %d" % len(new)
    f = new[0]
    assert f.GetReference().startswith("kobee-studio-"), f.GetReference()
    assert f.GetValue() == "Kobee Studio", f.GetValue()
    polys = [g for g in f.GraphicalItems() if g.GetShape() == pcbnew.SHAPE_T_POLY]
    assert len(polys) >= 2, "the artwork has %d outlines" % len(polys)
    assert all(g.GetLayer() == pcbnew.F_SilkS for g in polys), sorted({g.GetLayerName() for g in polys})
    box = f.GetBoundingBox()
    assert box.GetWidth() > pcbnew.FromMM(2) and box.GetHeight() > pcbnew.FromMM(0.5), (box.GetWidth(), box.GetHeight())
    assert f.GetFieldByName("KOBEE_STUDIO_DATA") is not None, "the artwork's settings are not stored with it"
    assert not messages(), "the plugin reported: %s" % messages()   # it hands the new artwork to the cursor (Move)
    assert f.IsSelected(), "the new artwork is not selected for the move"
    assert f.IsBoardOnly() and f.IsExcludedFromBOM()
    first = {"outlines": len(polys), "reference": f.GetReference(), "width_mm": round(pcbnew.ToMM(box.GetWidth()), 2)}

    # Edit: with the artwork selected the plugin opens on it and replaces it in place.
    uid, at = f.m_Uuid.AsString(), (f.GetPosition().x, f.GetPosition().y)
    count = len(list(pcbnew.GetBoard().GetFootprints()))
    import kicad_web
    try:
        kicad_web._actions[0].Run()                 # the same toolbar button, pressed again
    except SystemExit:
        pass
    assert seen.get("edited"), "the window did not open a second time"
    assert seen["loaded"] == "HELLO", "the window did not load the selected artwork: %r" % seen["loaded"]
    assert not messages(), "the plugin reported: %s" % messages()
    fps = list(pcbnew.GetBoard().GetFootprints())
    assert len(fps) == count, "editing added a footprint (%d before, %d after)" % (count, len(fps))
    g = [x for x in fps if x.m_Uuid.AsString() == uid]
    assert g, "the edited artwork lost its identity"
    g = g[0]
    assert (g.GetPosition().x, g.GetPosition().y) == at, "the edited artwork moved"
    again = [x for x in g.GraphicalItems() if x.GetShape() == pcbnew.SHAPE_T_POLY]
    wide = g.GetBoundingBox().GetWidth()
    assert again and wide < box.GetWidth(), "HI is not narrower than HELLO (%d against %d)" % (wide, box.GetWidth())
    first.update(edited_outlines=len(again), edited_width_mm=round(pcbnew.ToMM(wide), 2))
    return first
