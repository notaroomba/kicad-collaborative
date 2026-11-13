# board: demos/complex_hierarchy/complex_hierarchy.kicad_pcb
# select: 00000000-0000-0000-0000-00005592d065
"""Place Footprints: with Q201 selected, choose "by reference", keep Q201 to Q204 in the list, ask for a line with
10 mm steps, and expect Q202, Q203 and Q204 10, 20 and 30 mm to the right of Q201, which stays where it was."""
import pcbnew
import wx

from drive_util import messages

seen = {}


def _at(ref):
    p = pcbnew.GetBoard().FindFootprintByReference(ref).GetPosition()
    return p.x, p.y


def modal(dlg):
    name = type(dlg).__name__
    if name == "DeprecationDialog":
        return wx.ID_OK
    if name == "InitialDialog":
        seen["start"] = {r: _at(r) for r in ("Q201", "Q202", "Q203", "Q204")}
        dlg.on_by_reference(wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED))
        return dlg.GetReturnCode()
    if name == "PlaceByReferenceDialog":
        seen["listed"] = [dlg.list_footprints.GetString(i) for i in range(dlg.list_footprints.GetCount())]
        dlg.com_arr.SetStringSelection("Linear")
        dlg.arr_changed(wx.CommandEvent(wx.wxEVT_COMMAND_COMBOBOX_SELECTED))
        dlg.val_x_mag.SetValue("10")
        dlg.val_y_angle.SetValue("0")
        dlg.val_nth.SetValue("1")
        dlg.val_rotate.SetValue("0")
        dlg.on_ok(wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED, wx.ID_OK))    # checks the values, then lets OK close
        return wx.ID_OK
    seen.setdefault("other", []).append(name)
    return None


def after_run(_action):
    assert seen.get("listed") == ["Q201", "Q202", "Q203", "Q204"], "the list holds %s; %s" % (seen.get("listed"), messages())
    assert not seen.get("other"), "unexpected windows: %s" % seen["other"]
    x0, y0 = seen["start"]["Q201"]
    assert _at("Q201") == (x0, y0), "the anchor moved"
    for i, ref in enumerate(("Q202", "Q203", "Q204"), 1):
        x, y = _at(ref)
        assert abs(x - (x0 + pcbnew.FromMM(10 * i))) <= 1000 and abs(y - y0) <= 1000, \
            "%s is at %.3f, %.3f mm from the anchor, not %d, 0" % (ref, pcbnew.ToMM(x - x0), pcbnew.ToMM(y - y0), 10 * i)
        assert _at(ref) != seen["start"][ref], "%s did not move" % ref
    return {"placed": {r: [round(pcbnew.ToMM(v), 3) for v in _at(r)] for r in ("Q201", "Q202", "Q203", "Q204")}}
