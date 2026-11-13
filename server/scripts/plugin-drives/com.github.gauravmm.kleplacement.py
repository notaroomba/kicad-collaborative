# board: server/scripts/plugin-drives/boards/keyboard-2x2.kicad_pcb
"""KLE Placement: four switches scattered about the board, and a 2 by 2 keyboard layout pasted into the window with
the prefix SW chosen.  Expect the four switches on a 19.05 mm grid whose top left corner is the leftmost and topmost
of where they started, one switch per key, each one that had to move turned to 180 degrees, and the diodes left where they were."""
import pcbnew
import wx

seen = {}
KLE = '["A","B"],\n["C","D"]\n'
U = 19.05


def _at():
    return {fp.GetReference(): (round(pcbnew.ToMM(fp.GetPosition().x), 3), round(pcbnew.ToMM(fp.GetPosition().y), 3), round(fp.GetOrientationDegrees() % 360, 3))
            for fp in pcbnew.GetBoard().GetFootprints()}


def modal(dlg):
    name = type(dlg).__name__
    if name != "DlgKLEP":
        from drive_util import label_of, find_all
        seen.setdefault("said", []).append(name + ": " + " | ".join(label_of(w) for w in find_all(wx.StaticText, root=dlg))[:300])
        return wx.ID_CANCEL
    seen["before"] = _at()
    assert "SW" in dlg.prefixes and "D" in dlg.prefixes, dlg.prefixes
    dlg.choicePrefix.SetSelection(dlg.prefixes.index("SW"))
    dlg.txtKLEJson.SetValue(KLE)
    dlg.apply(wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED))
    return dlg.GetReturnCode()


def after_run(action):
    assert "said" not in seen, seen["said"]
    before, after = seen["before"], _at()
    sw = sorted(r for r in before if r.startswith("SW"))
    assert len(sw) == 4, sw
    x0, y0 = min(before[r][0] for r in sw), min(before[r][1] for r in sw)
    want = {(round(x0 + i * U, 3), round(y0 + j * U, 3)) for i in (0, 1) for j in (0, 1)}
    got = {after[r][:2] for r in sw}
    assert all(any(abs(g[0] - w[0]) < 0.002 and abs(g[1] - w[1]) < 0.002 for g in got) for w in want) and len(got) == 4, f"the switches are at {sorted(got)}, the keys are at {sorted(want)}"
    # a switch that already sat on a key is left exactly as it was (the plugin's rule); every other one is placed
    # and turned to 180 degrees
    stayed = [r for r in sw if after[r] == before[r]]
    placed = [r for r in sw if r not in stayed]
    assert len(placed) >= 3 and all(after[r][2] == 180.0 for r in placed), {r: after[r] for r in sw}
    assert all(any(abs(before[r][0] - w[0]) < 0.011 and abs(before[r][1] - w[1]) < 0.011 for w in want) for r in stayed), f"{stayed} did not move although not on a key"
    others = [r for r in before if not r.startswith("SW")]
    assert others and all(after[r] == before[r] for r in others), "a footprint that is not a switch moved"
    return {"switches": {r: list(after[r]) for r in sw}, "already_on_a_key": stayed, "untouched": len(others)}
