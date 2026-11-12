# board: demos/royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb
"""PCB Heatmap: wait for the board picture, choose "source" and click a pad of a supply net on the plugin's own drawing of
the board, give it a voltage; choose "load", click another pad of that net, give it a current; press Run and expect the
solver (numpy, started by the plugin as a second Python program) to return a temperature map that the window then paints."""
import wx
from drive_util import windows, find_all, press, messages, painted, label_of

seen = {"values": []}


def modal(dlg):
    editor = getattr(dlg, "editor", None)
    if editor is None:
        return None
    text = label_of(next(iter(find_all(wx.StaticText, root=dlg)), None)) if find_all(wx.StaticText, root=dlg) else ""
    value = "3.3" if "voltage" in text.lower() else "0.5"
    editor.SetValue(value)
    seen["values"].append((text.splitlines()[0][:60], value))
    return wx.ID_OK


def click_pad(frame, pad):
    canvas = frame.canvas
    x, y = canvas.world_to_screen(pad["x_mm"], pad["y_mm"])
    press(canvas, int(round(x)), int(round(y)))


def after_run(_action):
    frame = next((w for w in windows() if hasattr(w, "canvas") and hasattr(w, "run_button")), None)
    assert frame is not None, "the plugin's window did not open: %s" % messages()[-2:]
    assert frame.inspection is not None, "the plugin did not read the board: %s" % messages()[-2:]
    if not wx._DOM:          # no screen here: the board picture gets the size it has in a window on a desktop
        frame.canvas.SetMinSize((1100, 800))
        frame.canvas.fit_board()
    pads = list(frame.pad_by_id.values())
    by_net = {}
    shown = frame.canvas.layer          # the copper layer the picture shows (the first one)
    for p in pads:
        if p.get("net") and shown in (p.get("layers") or []):
            by_net.setdefault(p["net"], []).append(p)
    # a supply net: the non-ground net with the most pads
    net, group = max(((n, g) for n, g in by_net.items() if "GND" not in n.upper()), key=lambda it: len(it[1]))
    refs = {}
    for p in group:
        refs.setdefault(p.get("reference", ""), p)
    assert len(refs) >= 2, "net %s has pads on one part only" % net
    a, b = list(refs.values())[0], list(refs.values())[-1]
    press(frame.mode_buttons["source"])
    click_pad(frame, a)
    press(frame.mode_buttons["load"])
    click_pad(frame, b)
    kinds = sorted(r["kind"] for r in frame.rows)
    assert kinds == ["load", "source"], "the clicks on the board picture made %s, not a source and a load: %s" % (kinds, messages()[-3:])
    assert frame.run_button.IsEnabled(), "Run is switched off"
    press(frame.run_button)
    assert frame.result is not None, "the solver returned nothing: %s" % messages()[-3:]
    arrays = frame.arrays
    kind = frame.result.get("analysis_kind")
    import numpy as np
    hot = round(float(np.nanmax(arrays["temperature_c"])), 3) if "temperature_c" in arrays else None
    assert hot is None or hot > 20, "the temperature map is empty"
    drawn = painted(frame.canvas)
    assert any(op[0] == "img" for op in drawn), "the result map was not painted on the board picture"
    return {"net": net, "source": a["label"], "load": b["label"], "asked": seen["values"], "analysis": kind,
            "status": frame.result.get("thermal_status"), "hottest_c": hot, "arrays": sorted(arrays)[:6],
            "paint_steps": len(drawn), "said": [m[:200] for m in messages()[-2:]]}
