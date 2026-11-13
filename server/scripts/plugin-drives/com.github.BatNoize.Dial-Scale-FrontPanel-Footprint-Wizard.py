# board: server/scripts/plugin-drives/boards/empty.kicad_pcb
"""Dial Scale footprint wizard: in its window, ask for 7 major tick marks (instead of 11), switch the minor ticks on
(4 between two major ones) and press "Place on Board".

Expect one footprint on the board holding: an unplated hole of 7.5 mm (radius 3.75) with a 0.2 mm pad; 7 silkscreen
lines 0.2 mm wide from radius 5.5 to radius 8 mm, pointing away from the centre, 50 degrees apart over 300 degrees;
24 lines 0.15 mm wide from radius 5.5 to 7.2 mm, 10 degrees apart between the major ones; and the help circle of
10 mm radius, 0.05 mm wide."""
import math
import pcbnew
import wx
from drive_util import click

seen = {}
ASK = {("Tick_Marks", "num_Major_Ticks"): "7", ("Tick_Marks", "active_Minor"): True}


def modal(dlg):
    assert type(dlg).__name__ == "WizardDialog", type(dlg).__name__
    start = {(p.page, p.name): c.GetValue() for p, c in dlg.controls}
    assert str(start[("Tick_Marks", "num_Major_Ticks")]) == "11" and start[("Tick_Marks", "active_Minor")] is False and str(start[("Hole", "hole_radius")]) == "3.75", "the window does not open with the wizard's own values"
    for p, c in dlg.controls:
        if (p.page, p.name) in ASK:
            c.SetValue(ASK[(p.page, p.name)])
            kind = wx.EVT_CHECKBOX if isinstance(c, wx.CheckBox) else wx.EVT_TEXT
            c._wx_fire(kind, wx.Event(c, kind))
    seen["notes"] = dlg.messages.GetValue()
    click("Place on Board", dlg)
    return wx.ID_CANCEL


def after_run(action):
    fps = list(pcbnew.GetBoard().GetFootprints())
    assert len(fps) == 1, f"{len(fps)} footprints on the board; the wizard said: {seen.get('notes', '')[-300:]}"
    fp = fps[0]
    o = fp.GetPosition()
    mm = lambda p: (pcbnew.ToMM(p.x - o.x), pcbnew.ToMM(p.y - o.y))
    pads = list(fp.Pads())
    assert len(pads) == 1 and pads[0].GetAttribute() == pcbnew.PAD_ATTRIB_NPTH, [p.GetAttribute() for p in pads]
    assert abs(pcbnew.ToMM(pads[0].GetDrillSize().x) - 7.5) < 1e-6 and abs(pcbnew.ToMM(pads[0].GetSize().x) - 0.2) < 1e-6 and mm(pads[0].GetPosition()) == (0, 0)
    ticks = {0.2: [], 0.15: []}
    circles = []
    for g in fp.GraphicalItems():
        if not hasattr(g, "GetShape"):
            continue
        width = round(pcbnew.ToMM(g.GetWidth()), 4)
        if g.GetShape() == pcbnew.SHAPE_T_CIRCLE:
            circles.append((mm(g.GetCenter()), pcbnew.ToMM(g.GetRadius()), width, g.GetLayer()))
            continue
        assert g.GetShape() == pcbnew.SHAPE_T_SEGMENT and g.GetLayer() == pcbnew.F_SilkS and width in ticks, (g.GetShape(), g.GetLayerName(), width)
        (sx, sy), (ex, ey) = mm(g.GetStart()), mm(g.GetEnd())
        a, b = math.degrees(math.atan2(sy, sx)), math.degrees(math.atan2(ey, ex))
        assert abs((a - b + 180) % 360 - 180) < 0.01, f"a tick does not point away from the centre ({a:.2f} and {b:.2f} degrees)"
        ticks[width].append((round(math.hypot(sx, sy), 3), round(math.hypot(ex, ey), 3), a))

    def spread(rows, inner, outer, n, what):
        assert len(rows) == n, f"{len(rows)} {what} ticks, not {n}"
        assert all(abs(r0 - inner) < 2e-3 and abs(r1 - outer) < 2e-3 for r0, r1, _ in rows), f"{what} ticks do not run from {inner} to {outer} mm: {rows[:3]}"
        # angles around the circle, as steps from one tick to the next (the largest step is the gap the scale leaves open)
        angles = sorted(a % 360 for _, _, a in rows)
        steps = sorted((angles[(i + 1) % n] - angles[i]) % 360 for i in range(n))
        return angles, steps
    major, steps = spread(ticks[0.2], 5.5, 8.0, 7, "major")
    assert all(abs(s - 50) < 0.01 for s in steps[:-1]) and abs(steps[-1] - 60) < 0.01, f"major ticks are not 50 degrees apart over 300 degrees: {steps}"
    minor, steps = spread(ticks[0.15], 5.5, 7.2, 24, "minor")
    assert all(min(abs((m - M + 180) % 360 - 180) for M in major) > 9.9 for m in minor), "a minor tick sits on a major one"
    assert all(abs(min(abs((m - M + 180) % 360 - 180) for M in major) % 10) < 0.01 or abs(min(abs((m - M + 180) % 360 - 180) for M in major) % 10 - 10) < 0.01 for m in minor), "minor ticks are not 10 degrees apart"
    assert len({round(m, 1) for m in minor}) == 24
    assert len(circles) == 1 and circles[0][0] == (0, 0) and abs(circles[0][1] - 10) < 1e-6 and circles[0][2] == 0.05, circles
    return {"hole_mm": 7.5, "major_ticks": 7, "minor_ticks": 24, "help_circle_mm": 10, "layer_of_circle": pcbnew.GetBoard().GetLayerName(circles[0][3])}
