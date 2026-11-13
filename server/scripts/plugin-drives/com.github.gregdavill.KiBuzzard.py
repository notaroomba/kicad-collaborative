"""KiBuzzard: type a label, let it draw the preview from its own font files, press OK, and expect the label on the board:
the plugin puts a footprint on the clipboard and presses Ctrl+V in the editor, as it does in KiCad."""
import pcbnew
import wx

seen = {}


def modal(dlg):
    if type(dlg).__name__ != "Dialog" or "typed" in seen:
        return wx.ID_CANCEL
    seen["typed"] = True
    seen["before"] = len(list(pcbnew.GetBoard().GetFootprints()))
    dlg.m_MultiLineText.SetValue("HELLO")
    dlg.ReGeneratePreview()
    seen["error"] = dlg.error
    seen["polys"] = len(dlg.polys)
    dlg.OnOkClick(wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED, wx.ID_OK))
    return dlg.GetReturnCode() if dlg.GetReturnCode() else wx.ID_OK


def after_run(_action):
    assert seen.get("typed"), "KiBuzzard's window never opened"
    assert not seen.get("error"), "the preview failed: %s" % seen["error"]
    assert seen.get("polys", 0) > 0, "the label has no outline"
    fps = list(pcbnew.GetBoard().GetFootprints())
    assert len(fps) == seen["before"] + 1, "no label landed on the board (%d footprints before, %d after)" % (seen["before"], len(fps))
    new = [f for f in fps if "kibuzzard" in f.GetReference().lower()]
    assert new, "the new footprint is not a KiBuzzard label: %s" % [f.GetReference() for f in fps][-3:]
    return {"polys": seen["polys"], "reference": new[0].GetReference()}
