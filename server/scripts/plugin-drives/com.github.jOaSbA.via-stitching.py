# board: demos/stickhub/StickHub.kicad_pcb
"""Via Stitching: on a board whose GND is poured on the top and the bottom, pick GND, a square pattern with 0.6 mm
vias on a 1.5 mm pitch, press OK, and expect new GND vias, every one inside GND's filled copper on both layers and
none closer to another than the pitch less the quarter pitch the plugin may nudge a via off an obstacle."""
import math
import pcbnew
import wx
from drive_util import choose, click, messages

seen = {}
PITCH = 1.5


def _vias():
    return [t for t in pcbnew.GetBoard().GetTracks() if isinstance(t, pcbnew.PCB_VIA)]


def modal(dlg):
    if type(dlg).__name__ == "ViaStitchingDialogLegacy" and "before" not in seen:
        seen["before"] = {v.m_Uuid.AsString() for v in _vias()}
        choose(dlg.net, "GND")
        choose(dlg.pattern, "Square")
        dlg.via_dia.SetValue("0.6")
        dlg.drill.SetValue("0.3")
        dlg.spacing.SetValue(str(PITCH))
        click("OK", dlg)
        return dlg.GetReturnCode() or wx.ID_CANCEL
    return wx.ID_OK


def after_run(_action):
    assert "before" in seen, "the Via Stitching window never opened: %s" % messages()[-2:]
    said = messages()
    new = [v for v in _vias() if v.m_Uuid.AsString() not in seen["before"]]
    assert len(new) >= 10, "only %d vias were added; the plugin said: %s" % (len(new), said[-2:])
    assert any("Placed %d stitching vias" % len(new) in m for m in said), "the plugin's count differs from the %d new vias: %s" % (len(new), said[-1:])
    assert all(v.GetNetname() == "GND" for v in new), "vias on other nets: %s" % sorted({v.GetNetname() for v in new})
    assert all(abs(pcbnew.ToMM(v.GetWidth(pcbnew.F_Cu)) - 0.6) < 1e-6 and abs(pcbnew.ToMM(v.GetDrillValue()) - 0.3) < 1e-6 for v in new), "the vias are not 0.6/0.3 mm"
    zones = [z for z in pcbnew.GetBoard().Zones() if z.GetNetname() == "GND"]
    out = []
    for v in new:
        for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
            if not any(z.IsOnLayer(layer) and z.HitTestFilledArea(layer, v.GetPosition()) for z in zones):
                out.append((round(pcbnew.ToMM(v.GetPosition().x), 2), round(pcbnew.ToMM(v.GetPosition().y), 2), pcbnew.GetBoard().GetLayerName(layer)))
    assert not out, "%d of %d vias are not on GND's filled copper: %s" % (len(out), len(new), out[:4])
    pts = [(pcbnew.ToMM(v.GetPosition().x), pcbnew.ToMM(v.GetPosition().y)) for v in new]
    near = min(math.hypot(a[0] - b[0], a[1] - b[1]) for i, a in enumerate(pts) for b in pts[i + 1:])
    assert near > PITCH * 0.75 - 0.01, "two vias are %.3f mm apart; a %.1f mm pitch with a quarter-pitch nudge allows %.3f" % (near, PITCH, PITCH * 0.75)
    return {"vias": len(new), "closest_mm": round(near, 3), "said": [m[:120] for m in said[-1:]]}
