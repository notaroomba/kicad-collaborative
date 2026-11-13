# board: demos/ecc83/ecc83-pp.kicad_pcb
"""Center Silk Reference: all footprints, front side, text always horizontal, no pad nudging and no resizing.
Expect every footprint's reference designator moved to the middle of its courtyard (worked out here from the
courtyard's own lines and circles) and turned to 0 degrees, and the footprints themselves left where they were."""
import pcbnew
import wx

seen = {"said": []}


def _centre(fp):
    """The middle of the courtyard drawing, from its points (a line's ends, a circle's centre and radius)."""
    xs, ys = [], []
    for g in fp.GraphicalItems():
        if g.GetLayer() != pcbnew.F_CrtYd:
            continue
        if g.GetShape() == pcbnew.SHAPE_T_CIRCLE:
            c, r = g.GetCenter(), g.GetRadius()
            xs += [c.x - r, c.x + r]
            ys += [c.y - r, c.y + r]
        else:
            for p in (g.GetStart(), g.GetEnd()):
                xs.append(p.x)
                ys.append(p.y)
    return ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2) if xs else None


def _state():
    return {fp.GetReference(): (fp.Reference().GetPosition().x, fp.Reference().GetPosition().y, fp.Reference().GetTextAngle().AsDegrees(), fp.GetPosition().x, fp.GetPosition().y)
            for fp in pcbnew.GetBoard().GetFootprints()}


def modal(dlg):
    name = type(dlg).__name__
    if name != "SettingsDialog":
        from drive_util import label_of, find_all
        seen["said"].append(" | ".join(label_of(w) for w in find_all(wx.StaticText, root=dlg))[:400] or name)
        return wx.ID_OK
    seen["before"] = _state()
    assert dlg.rb_all.GetValue() and dlg.rb_front.GetValue(), "the window does not start on all footprints, front side"
    dlg.cb_fit.SetValue(False)
    dlg.cb_nudge.SetValue(False)
    dlg.rb_rot_zero.SetValue(True)
    assert dlg.rotation_mode == "zero", dlg.rotation_mode
    return wx.ID_OK


def after_run(action):
    before, after = seen["before"], _state()
    moved, off = 0, []
    for fp in pcbnew.GetBoard().GetFootprints():
        ref = fp.GetReference()
        c = _centre(fp)
        assert c is not None, f"{ref} has no courtyard on this board"
        x, y, angle, fx, fy = after[ref]
        if abs(x - c[0]) > 1000 or abs(y - c[1]) > 1000 or abs(angle) > 1e-6:      # a micrometre
            off.append((ref, pcbnew.ToMM(x - c[0]), pcbnew.ToMM(y - c[1]), angle))
        if (x, y) != before[ref][:2]:
            moved += 1
        assert (fx, fy) == before[ref][3:], f"{ref} itself moved"
    assert not off, f"references not in the middle of their courtyard, or not horizontal: {off[:6]}"
    assert moved >= 10, f"only {moved} references moved"
    return {"footprints": len(after), "moved": moved, "said": seen["said"][:2]}
