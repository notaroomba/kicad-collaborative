# board: demos/openair-max/One-Air-Max.kicad_pcb
"""Z0 field solver, on a four-layer board whose outer layers lie 0.1 mm over a plane (FR4 of 4.5, 35 um copper):
press Calculate with the window's own 50 ohm profile and expect a width for the outer layers whose impedance the
solver puts within 1 ohm of 50 and which the Hammerstad and Jensen microstrip formulas, worked out here on their
own, put within 8 % of 50; the same width on both outer layers (the stackup is symmetric); a narrower track for the
inner layer between two planes; and those numbers in the results table."""
import math
import wx
from drive_util import click, messages, texts

seen = {}


def _microstrip(w, h, t, er):
    """Hammerstad and Jensen (1980), with their correction for the copper's thickness."""
    eta = 376.730313668
    z01 = lambda u: eta / (2 * math.pi) * math.log((6 + (2 * math.pi - 6) * math.exp(-(30.666 / u) ** 0.7528)) / u + math.sqrt(1 + (2 / u) ** 2))

    def eeff(u):
        a = 1 + math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + math.log(1 + (u / 18.1) ** 3) / 18.7
        b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053
        return (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / u) ** (-a * b)
    u = w / h
    du1 = (t / h) / math.pi * math.log(1 + 4 * math.e / ((t / h) * (1 / math.tanh(math.sqrt(6.517 * u))) ** 2))
    u1, ur = u + du1, u + du1 * (1 + 1 / math.cosh(math.sqrt(er - 1))) / 2
    return z01(ur) / math.sqrt(eeff(ur)) , eeff(ur) * (z01(u1) / z01(ur)) ** 2


def modal(dlg):
    if not hasattr(dlg, "on_run") or "results" in seen:
        return wx.ID_OK
    seen["models"] = {k: m.kind for k, m in dlg.models.items()}
    click("Calculate", dlg)
    seen["results"] = [dict(r) for r in dlg.results]
    seen["table"] = [dlg.grid_res.GetCellValue(r, c) for r in range(dlg.grid_res.GetNumberRows()) for c in range(dlg.grid_res.GetNumberCols())]
    return wx.ID_CANCEL


def after_run(_action):
    assert "results" in seen, "the field solver's window never opened: %s" % messages()[-1:]
    assert seen["models"] == {"F.Cu": "microstrip", "In1.Cu": "stripline", "In2.Cu": "stripline", "B.Cu": "microstrip"}, "the stackup was read as %s" % seen["models"]
    rows = {r["layer"]: r for r in seen["results"] if r["profile"] == "SE50"}
    top, bottom, inner = rows["F.Cu"], rows["B.Cu"], rows["In1.Cu"]
    assert not top["error"] and top["width_mm"], "no width for 50 ohm on the top layer: %s" % top["error"]
    assert abs(top["z0"] - 50) < 1, "the solver's own impedance for its width is %.2f ohm" % top["z0"]
    z, _ = _microstrip(top["width_mm"], 0.1, 0.035, 4.5)
    assert abs(z - 50) < 4, "a %.4f mm track 0.1 mm over a plane is %.1f ohm by Hammerstad and Jensen, not near 50" % (top["width_mm"], z)
    assert abs(bottom["width_mm"] - top["width_mm"]) < 1e-6, "the two outer layers differ: %.4f and %.4f mm" % (top["width_mm"], bottom["width_mm"])
    assert not inner["error"] and 0.05 < inner["width_mm"] < top["width_mm"] and abs(inner["z0"] - 50) < 1, "the inner layer: %s" % {k: inner[k] for k in ("width_mm", "z0", "error")}
    shown = "%.4f" % top["width_mm"]
    assert any(shown in cell for cell in seen["table"]), "the results table does not show %s mm: %s" % (shown, [c for c in seen["table"] if c][:12])
    return {"top_width_mm": round(top["width_mm"], 4), "solver_ohm": round(top["z0"], 2), "formula_ohm": round(z, 2), "inner_width_mm": round(inner["width_mm"], 4)}
