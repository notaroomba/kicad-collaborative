# board: demos/ecc83/ecc83-pp.kicad_pcb
"""Archive 3D models: run it on a board whose footprints name models of KiCad's 3D library (and one model file of its
own that this project does not have).  Expect every library model copied into packages3D in the project folder as
a STEP file, the footprints pointed at the copies (${KIPRJMOD}/packages3D/...), the copies taken into the project,
and the one missing model named in the end report (the plugin's default setting repoints it all the same)."""
import os

import pcbnew
import wx

from drive_util import messages, find_all, label_of

seen = {"windows": []}
COPIED = ["Altech_AK300_1x02_P5.00mm_45-Degree.step", "CP_Radial_D10.0mm_P5.00mm.step", "C_Disc_D4.7mm_W2.5mm_P5.00mm.step",
          "R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal.step"]


def _models():
    return {fp.GetReference(): [m.m_Filename for m in fp.Models()] for fp in pcbnew.GetBoard().GetFootprints() if len(fp.Models())}


def _said(dlg):
    return " | ".join([label_of(w) for w in find_all(wx.StaticText, root=dlg)] + [str(w.GetValue()) for w in find_all(wx.TextCtrl, root=dlg)])


def modal(dlg):
    name = type(dlg).__name__
    seen["windows"].append(name)
    if name == "DeprecationDialog":
        return wx.ID_OK
    if name == "MainWindow":
        seen["before"] = _models()
        dlg.on_run(wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED))
        return dlg.GetReturnCode() or wx.ID_OK
    if name == "EndReport":
        seen["report"] = _said(dlg)
        return wx.ID_OK
    seen["trouble"] = name + ": " + _said(dlg)[-1200:]
    return wx.ID_OK


def after_run(_action):
    assert "trouble" not in seen, "the plugin reported an error: %s; %s" % (seen["trouble"], messages())
    assert "EndReport" in seen["windows"], "the plugin never finished: %s" % seen["windows"]
    before, now = seen["before"], _models()
    assert sum(len(v) for v in before.values()) == 11 and sum(len(v) for v in now.values()) == 11, "the board lost or gained models: %s" % now
    copied = sorted(os.listdir("/project/packages3D"))
    assert copied == COPIED, "copied: %s" % copied
    for name in copied:
        with open("/project/packages3D/" + name, "rb") as f:
            head = f.read(12)
        assert head == b"ISO-10303-21", "%s is not a STEP file" % name
    stems = {os.path.splitext(n)[0] for n in copied}
    remapped = missing = 0
    for ref, paths in now.items():
        for old, new in zip(before[ref], paths):
            stem = os.path.splitext(os.path.basename(old))[0]
            assert new.startswith("${KIPRJMOD}/packages3D/") and os.path.splitext(os.path.basename(new))[0] == stem, "%s still names %s" % (ref, new)
            if "KIPRJMOD" in old:           # the valve's own model, which this project does not hold
                assert stem not in stems
                missing += 1
            else:
                assert stem in stems, "%s names %s, which was not copied (%s)" % (ref, new, copied)
                remapped += 1
    assert remapped == 10 and missing == 1, "remapped %d, missing %d" % (remapped, missing)
    assert "ecc83" in seen.get("report", ""), "the end report does not name the missing model: %s" % seen.get("report")
    return {"copied": copied, "remapped": remapped, "report": seen["report"][:200]}
