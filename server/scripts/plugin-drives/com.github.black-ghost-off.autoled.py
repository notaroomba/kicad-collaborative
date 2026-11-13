"""AutoLED: hand it a drawing of an ellipse 50 mm wide and 30 mm high (a 60 x 40 pixel image at 1 mm a pixel), ask
for WS2812B LEDs on a 6 mm pitch from (200, 100) mm with a capacitor each and both connectors, no autorouting, and
press Generate.  Expect the LEDs on that pitch in rows that follow the ellipse (short, long, long, short and each
centred on the same axis), numbered in a serpentine, wired as one chain (each LED's data in is the one before's
data out), a capacitor per LED across +5V and GND, the two connectors, and the LED list it writes agreeing."""
import json
import pcbnew
import wx
from drive_util import click, messages, texts

seen = {}
PITCH, OX, OY = 6.0, 200.0, 100.0


def modal(dlg):
    if "before" in seen:
        return wx.ID_CANCEL
    from PIL import Image, ImageDraw
    image = Image.new("L", (60, 40), 255)
    ImageDraw.Draw(image).ellipse((5, 5, 54, 34), fill=0)
    image.save("/tmp/autoled-shape.png")
    seen["before"] = {f.m_Uuid.AsString() for f in pcbnew.GetBoard().GetFootprints()}
    want = {"image_path": "/tmp/autoled-shape.png", "width_mm": 60.0, "pitch_x": PITCH, "pitch_y": PITCH, "preset": "WS2812B (5050)",
            "decoupling": True, "connectors": True, "gen_sch": False, "route": False, "origin_x": OX, "origin_y": OY}
    for key, value in want.items():
        control, kind, opts = dlg.controls[key]
        if kind == "choice":
            control.SetSelection([v for v, _ in opts["choices"]].index(value))
        elif kind in ("file", "dir"):
            control.SetPath(value)
        else:
            control.SetValue(value)
    dlg.update_preview()
    seen["status"] = dlg.status.GetLabel()
    click("Generate", dlg)
    seen["log"] = [t for t in texts(dlg) if "Done." in t or "ERROR" in t][-1:]
    return wx.ID_CANCEL


def after_run(_action):
    assert "before" in seen, "the AutoLED window never opened: %s" % messages()[-1:]
    mm = pcbnew.ToMM
    new = [f for f in pcbnew.GetBoard().GetFootprints() if f.m_Uuid.AsString() not in seen["before"]]
    log = (seen["log"] or [""])[0]
    assert new and "ERROR" not in log, "nothing was placed; AutoLED said: %s %s" % (log[-500:], messages()[-1:])
    leds = sorted((f for f in new if f.GetReference().startswith("D")), key=lambda f: int(f.GetReference()[1:]))
    caps = [f for f in new if f.GetReference().startswith("C")]
    conns = sorted(f.GetReference() for f in new if f.GetReference().startswith("J"))
    assert "%d LEDs" % len(leds) in seen["status"] and len(leds) >= 12, "%d LEDs on the board; the window announced: %s" % (len(leds), seen["status"])
    assert all("WS2812B" in str(f.GetFPID().GetLibItemName()) and len(list(f.Pads())) == 4 for f in leds), "the LEDs are not the WS2812B footprint of KiCad's library"
    rows = {}
    for f in leds:
        x, y = mm(f.GetPosition().x) - OX, mm(f.GetPosition().y) - OY
        assert abs(x / PITCH - round(x / PITCH)) < 1e-6 and abs(y / PITCH - round(y / PITCH)) < 1e-6 and x >= 0 and y >= 0, "%s is off the 6 mm grid from the origin: %.3f, %.3f" % (f.GetReference(), x, y)
        rows.setdefault(round(y / PITCH), []).append(round(x / PITCH))
    counts = [len(rows[r]) for r in sorted(rows)]
    middles = {min(c) + max(c) for c in rows.values()}
    assert sorted(rows) == list(range(len(rows))) and len(rows) >= 3 and min(rows[0]) == min(min(c) for c in rows.values()) + (max(counts) - counts[0]) // 2, "the rows do not start at the origin: %s" % rows
    assert counts == counts[::-1] and counts[0] < max(counts) and len(middles) == 1 and all(sorted(c) == list(range(min(c), max(c) + 1)) for c in rows.values()), \
        "the rows do not follow an ellipse (%s LEDs a row, centred on %s)" % (counts, sorted(middles))
    assert rows[0] == sorted(rows[0]) and rows[1] == sorted(rows[1], reverse=True), "the numbering is not a serpentine: %s then %s" % (rows[0], rows[1])
    nets = [{str(p.GetNumber()): p.GetNetname() for p in f.Pads()} for f in leds]
    # the WS2812B: 1 VDD, 2 DOUT, 3 VSS, 4 DIN
    broken = [leds[i].GetReference() for i in range(1, len(leds)) if nets[i]["4"] != nets[i - 1]["2"] or nets[i]["1"] != "/+5V" or nets[i]["3"] != "/GND"]
    assert not broken and len({n["2"] for n in nets}) == len(leds), "the chain is broken at %s" % broken[:4]
    assert len(caps) == len(leds) and all(sorted(p.GetNetname() for p in c.Pads()) == ["/+5V", "/GND"] for c in caps), "there is not one capacitor across the supply for each LED (%d for %d)" % (len(caps), len(leds))
    assert conns == ["J1", "J2"], "the connectors are %s" % conns
    listed = json.load(open("/project/leds.json"))
    lists = [v for v in (listed.values() if isinstance(listed, dict) else [listed]) if isinstance(v, list) and v and isinstance(v[0], dict)]
    assert any(len(v) == len(leds) for v in lists), "the LED list written holds %s entries for %d LEDs" % ([len(v) for v in lists], len(leds))
    return {"leds": len(leds), "rows": counts, "caps": len(caps), "connectors": conns, "log": log[-120:]}
