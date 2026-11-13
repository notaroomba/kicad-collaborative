"""Text Size & Position: tick Reference and the size box, ask for 1.2 x 1.1 mm on every footprint (not only the selection),
press Ok, and expect every reference text on the board to have that size."""
import pcbnew
import wx
from drive_util import windows, tick, fire, click


def after_run(_action):
    dlg = [w for w in windows() if type(w).__name__ == "TextPosSizeDialog"]
    assert dlg, "the Text Size & Position window never opened"
    dlg = dlg[0]
    tick(dlg.text_ref)
    tick(dlg.size_enable)
    tick(dlg.m_onlyProcessSelection, False)
    dlg.ref_width.SetValue(1.2)
    dlg.ref_height.SetValue(1.1)
    fire(dlg.ref_width, wx.EVT_TEXT)
    click("Ok", dlg)
    fps = list(pcbnew.GetBoard().GetFootprints())
    assert fps, "the test board has no footprints"
    wrong = [f.GetReference() for f in fps
             if abs(pcbnew.ToMM(f.Reference().GetTextWidth()) - 1.2) > 1e-6 or abs(pcbnew.ToMM(f.Reference().GetTextHeight()) - 1.1) > 1e-6]
    assert not wrong, "these references kept their old size: %s" % wrong[:8]
    return {"references_resized": len(fps)}
