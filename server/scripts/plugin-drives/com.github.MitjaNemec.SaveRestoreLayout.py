# board: demos/complex_hierarchy/complex_hierarchy.kicad_pcb
# select: 00000000-0000-0000-0000-00005592d065
# pick: saved
"""Save/Restore Layout: with Q201 of the first amplifier selected, save that sheet's layout to a file; then select
Q301 of the second amplifier, restore from the file just saved, and expect the second amplifier's parts arranged
around Q301 exactly as the first amplifier's are around Q201."""
import math
import pcbnew
import wx

from drive_util import messages

seen = {"modals": []}


def _spread(board, anchor, hundred):
    a = board.FindFootprintByReference(anchor).GetPosition()
    out = {}
    for f in board.GetFootprints():
        ref = f.GetReference()
        digits = "".join(c for c in ref if c.isdigit())
        if len(digits) == 3 and digits[0] == hundred:
            p = f.GetPosition()
            out[ref.rstrip("0123456789") + digits[1:]] = math.hypot(p.x - a.x, p.y - a.y)
    return out


def modal(dlg):
    name = type(dlg).__name__
    seen["modals"].append(name)
    click = wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED)
    if name == "DeprecationDialog":
        return wx.ID_OK
    if name == "InitialDialog":
        (dlg.on_restore if seen.get("saved") else dlg.on_save)(click)
        return dlg.GetReturnCode()
    if name == "SaveDialog":
        seen["levels"] = [dlg.list_levels.GetString(i) for i in range(dlg.list_levels.GetCount())]
        dlg.list_levels.SetSelection(0)
        dlg.level_changed(wx.CommandEvent(wx.wxEVT_COMMAND_LISTBOX_SELECTED))
        return wx.ID_OK
    if name == "RestoreDialog":
        return wx.ID_OK
    if name == "ErrorDialog":
        import os
        seen["log"] = open("save_restore_layout.log").read()[-600:] if os.path.exists("save_restore_layout.log") else "no log"
    return None


def after_run(_action):
    board = pcbnew.GetBoard()
    assert seen.get("levels"), "the save window listed no hierarchy level: %s %s" % (seen.get("log") or seen["modals"], messages()[-2:])
    assert not messages(), "saving said: %s" % messages()[-1][:500]
    source = _spread(board, "Q201", "2")
    before = _spread(board, "Q301", "3")
    differ = [k for k in source if k in before and abs(source[k] - before[k]) > 2000]
    assert differ, "the two amplifiers are already laid out alike, the test would prove nothing"
    seen["saved"] = True

    # now the other amplifier: select its Q301 and restore
    for f in board.GetFootprints():
        (f.SetSelected if f.GetReference() == "Q301" else f.ClearSelected)()
    pcbnew.Refresh()
    import kicad_web
    kicad_web._actions[0].Run()
    assert "RestoreDialog" in seen["modals"], "the restore window never opened: %s %s" % (seen.get("log") or seen["modals"], messages()[-2:])
    assert not messages(), "restoring said: %s" % messages()[-1][:500]
    after = _spread(pcbnew.GetBoard(), "Q301", "3")
    off = [(k, round(source[k] / 1e6, 3), round(after[k] / 1e6, 3)) for k in source if k in after and abs(source[k] - after[k]) > 2000]
    assert "ErrorDialog" not in seen["modals"], "the plugin failed: %s" % seen.get("log")
    assert not off, "%d of %d parts are not where the first amplifier has them: %s" % (len(off), len(source), off[:5])
    return {"levels": seen["levels"], "parts_checked": len([k for k in source if k in after]), "moved": len(differ)}
