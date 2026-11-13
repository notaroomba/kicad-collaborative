# board: demos/openair-max/One-Air-Max.kicad_pcb
"""Z0 Wavelab on a routed four-layer board.  Net check: every routed net is listed, no net is listed longer than its copper, the nets of a
single path are listed with exactly the length of their tracks, and the skew it reports for the USB data pair is the difference of
that pair's two lengths.  Monte Carlo for a 0.2 mm track on the top layer (0.1 mm over a plane): a mean impedance
near the Hammerstad and Jensen value, and a yield that is what its own mean and spread give for a +-10 % band.
Wave / TDR into 50 ohm: the same impedance, the reflection (Z0 - 50) / (Z0 + 50), and its picture written."""
import math
import os
import re
import pcbnew
import wx
from drive_util import click, messages, windows

seen = {}


def _work(d):
    click("Analyse routed nets", d)
    seen["rows"] = {d.lc.GetItemText(i, 0): float(d.lc.GetItemText(i, 1)) for i in range(d.lc.GetItemCount())}
    seen["pairs"] = d.pairs.GetLabel()
    click("Run Monte Carlo", d)
    seen["mc"] = d.m_res.GetLabel()
    click("Simulate (makes MP4)", d)
    seen["tdr"] = d.t_res.GetLabel()
    seen["files"] = {f: os.path.getsize(os.path.join(d.out, f)) for f in os.listdir(d.out)}


def modal(d):
    if hasattr(d, "on_nets") and not seen:
        _work(d)
    return wx.ID_CANCEL


def _z_microstrip(w, h, t, er):
    eta = 376.730313668
    z01 = lambda u: eta / (2 * math.pi) * math.log((6 + (2 * math.pi - 6) * math.exp(-(30.666 / u) ** 0.7528)) / u + math.sqrt(1 + (2 / u) ** 2))
    u = w / h
    a = lambda u: 1 + math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + math.log(1 + (u / 18.1) ** 3) / 18.7
    eeff = lambda u: (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / u) ** (-a(u) * 0.564 * ((er - 0.9) / (er + 3)) ** 0.053)
    du = (t / h) / math.pi * math.log(1 + 4 * math.e / ((t / h) * (1 / math.tanh(math.sqrt(6.517 * u))) ** 2))
    ur = u + du * (1 + 1 / math.cosh(math.sqrt(er - 1))) / 2
    return z01(ur) / math.sqrt(eeff(ur))


def after_run(_action):
    for w in windows():
        if hasattr(w, "on_nets") and not seen:
            _work(w)
    assert seen, "the Wavelab window never opened: %s" % messages()[-1:]
    lengths, ends = {}, {}
    for t in pcbnew.GetBoard().GetTracks():
        if not isinstance(t, pcbnew.PCB_VIA) and t.GetNetname():
            lengths[t.GetNetname()] = lengths.get(t.GetNetname(), 0) + pcbnew.ToMM(t.GetLength())
            ends.setdefault(t.GetNetname(), []).append({(t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y)})
    rows = seen["rows"]
    assert set(rows) == set(lengths), "the list has %d nets, the board %d routed ones; differing: %s" % (len(rows), len(lengths), sorted(set(rows) ^ set(lengths))[:4])
    longer = [n for n in rows if rows[n] > lengths[n] + 0.006]
    assert not longer, "nets listed longer than all their tracks together: %s" % longer[:4]
    # a net of one track, or of two that meet end to end, has one path: its length is all of its copper
    simple = [n for n, e in ends.items() if len(e) == 1 or (len(e) == 2 and e[0] & e[1])]
    wrong = [(n, rows[n], round(lengths[n], 3)) for n in simple if abs(rows[n] - lengths[n]) > 0.006]
    assert len(simple) >= 3 and not wrong, "of %d single-path nets, these are listed with another length than their tracks': %s" % (len(simple), wrong[:4])
    skew = re.search(r"/USB_D\+//USB_D-: (-?[\d.]+) mm", seen["pairs"])
    assert skew and abs(float(skew.group(1)) - (rows["/USB_D+"] - rows["/USB_D-"])) < 0.011, "the USB pair's skew is not the difference of its lengths: %s" % seen["pairs"][-120:]
    mc = re.search(r"Z0 = ([\d.]+) ± ([\d.]+) Ω.*?: ([\d.]+) %", seen["mc"])
    assert mc, "Monte Carlo gave no result: %s" % seen["mc"]
    mean, std, yld = (float(x) for x in mc.groups())
    formula = _z_microstrip(0.2, 0.1, 0.035, 4.5)
    assert abs(mean - formula) < 3, "the mean is %.1f ohm; Hammerstad and Jensen give %.1f for this track" % (mean, formula)
    normal = 100 * math.erf(0.1 * mean / std / math.sqrt(2))
    assert 0.5 < std < 4 and abs(yld - normal) < 1.5, "a spread of %.1f ohm gives a yield of %.1f %%, not the %.1f %% reported" % (std, normal, yld)
    tdr = re.search(r"Z0 = ([\d.]+) Ω.*? (-?[\d.]+) %", seen["tdr"])
    assert tdr and abs(float(tdr.group(1)) - mean) < 0.5, "the wave simulation's impedance differs: %s" % seen["tdr"]
    z = float(tdr.group(1))
    assert abs(float(tdr.group(2)) - 100 * (z - 50) / (z + 50)) < 0.15, "the reflection is not (Z0 - 50) / (Z0 + 50): %s" % seen["tdr"]
    assert seen["files"].get("tdr.png", 0) > 10000 and seen["files"].get("mc.png", 0) > 10000, "the pictures were not written: %s" % seen["files"]
    return {"nets": len(rows), "single_path_nets": len(simple), "usb_skew_mm": float(skew.group(1)), "monte_carlo": [mean, std, yld], "formula_ohm": round(formula, 1), "tdr": seen["tdr"][:60]}
