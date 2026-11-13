# board: demos/ecc83/ecc83-pp.kicad_pcb
"""Set Hole Diameter: type 1.1 into the window and press Ok.  Expect every pad of every footprint drilled 1.1 mm
round, whatever it was before (this board has 0.8, 1.0, 1.3 and 3.2 mm holes), and the pads otherwise unchanged."""
import pcbnew
import wx

seen = {}


def _pads():
    return [(fp.GetReference(), p.GetPadName(), pcbnew.ToMM(p.GetDrillSize().x), pcbnew.ToMM(p.GetDrillSize().y), pcbnew.ToMM(p.GetSize().x))
            for fp in pcbnew.GetBoard().GetFootprints() for p in fp.Pads()]


def modal(dlg):
    assert type(dlg).__name__ == "DiameterDialog", type(dlg).__name__
    seen["before"] = _pads()
    assert dlg.tc.GetValue() == "0.8", dlg.tc.GetValue()
    dlg.tc.SetValue("1.1")
    dlg.on_ok(wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED))
    return dlg.GetReturnCode()


def after_run(action):
    before, after = seen["before"], _pads()
    assert len(before) == len(after) >= 30, (len(before), len(after))
    was = sorted({round(b[2], 3) for b in before})
    assert len(was) >= 3, f"the board should start with several hole sizes, it has {was}"
    wrong = [a for a in after if abs(a[2] - 1.1) > 1e-6 or abs(a[3] - 1.1) > 1e-6]
    assert not wrong, f"pads not drilled 1.1 mm: {wrong[:5]}"
    assert [b[4] for b in before] == [a[4] for a in after], "a pad's copper size changed"
    return {"pads": len(after), "holes_before": was, "holes_after": 1.1}
