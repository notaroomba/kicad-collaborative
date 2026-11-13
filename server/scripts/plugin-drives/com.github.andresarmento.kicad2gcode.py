"""kicad2gcode: give both windows a 2 mm cutter (and the cut 1.6 mm deep in 0.8 mm passes), press OK, and read the
G-code back: the cut must run one cutter radius outside the board outline at both depths with four tabs left, and
the drill file must plunge once at every drilled pad of the board, at that pad's place, grouped by drill size."""
import re
import pcbnew
import wx
from drive_util import click, messages

TOOL = 2.0


def modal(dlg):
    fields = getattr(dlg, "_fields", None)
    if not fields:
        return wx.ID_OK
    fields["TOOL_DIAMETER"].SetValue(str(TOOL))
    if "CUT_DEPTH" in fields:
        fields["CUT_DEPTH"].SetValue("-1.6")
        fields["MULTI_DEPTH"].SetValue("0.8")
    click("OK", dlg)
    return dlg.GetReturnCode() or wx.ID_OK


def _edge():
    xs, ys = [], []
    for d in pcbnew.GetBoard().GetDrawings():
        if d.GetLayer() == pcbnew.Edge_Cuts:
            for p in (d.GetStart(), d.GetEnd()):
                xs.append(pcbnew.ToMM(p.x))
                ys.append(pcbnew.ToMM(p.y))
    assert xs, "the test board has no outline"
    return min(xs), min(ys), max(xs), max(ys)


def _moves(text):
    return [(m.group(1), float(m.group(2)), float(m.group(3))) for m in re.finditer(r"^(G0|G1) X(-?[\d.]+) Y(-?[\d.]+)", text, re.M)]


def after_run(action):
    x0, y0, x1, y1 = _edge()
    said = messages()
    if "Edge" in action:
        text = open("/project/ecc83-pp_cut.nc").read()
        pts = _moves(text)[1:]                     # the first move is the park at the origin
        w, h = max(p[1] for p in pts), max(p[2] for p in pts)
        assert min(p[1] for p in pts) == 0 and min(p[2] for p in pts) == 0, "the cut does not start at the origin"
        assert abs(w - (x1 - x0 + TOOL)) < 0.002 and abs(h - (y1 - y0 + TOOL)) < 0.002, \
            "the cut is %.3f x %.3f mm; the outline %.3f x %.3f mm plus a 2 mm cutter is %.3f x %.3f" % (w, h, x1 - x0, y1 - y0, x1 - x0 + TOOL, y1 - y0 + TOOL)
        off = [p for p in pts if p[0] == "G1" and not (p[1] in (0, w) or p[2] in (0, h))]
        assert not off, "cutting moves leave the outline: %s" % off[:3]
        plunges = re.findall(r"^G1 Z(-[\d.]+)", text, re.M)
        assert sorted(set(plunges)) == ["-0.800", "-1.600"], "the passes are at %s, not -0.8 and -1.6" % sorted(set(plunges))
        assert len(plunges) == 8, "%d plunges; four tabs at two depths make 8" % len(plunges)
        return {"cut_mm": [w, h], "passes": sorted(set(plunges)), "plunges": len(plunges), "said": said[-1:]}
    text = open("/project/ecc83-pp_drill.nc").read()
    want = {}
    for fp in pcbnew.GetBoard().GetFootprints():
        for pad in fp.Pads():
            d = pcbnew.ToMM(pad.GetDrillSize().x)
            if d > 0:
                p = pad.GetPosition()
                want.setdefault(round(d, 3), set()).add((round(pcbnew.ToMM(p.x) - x0 + TOOL / 2, 2), round(y1 - pcbnew.ToMM(p.y) + TOOL / 2, 2)))
    got, bit = {}, None
    for line in text.splitlines():
        m = re.match(r"\(Bit: ([\d.]+)mm", line)
        if m:
            bit = round(float(m.group(1)), 3)
        m = re.match(r"G0 X(-?[\d.]+) Y(-?[\d.]+)", line)
        if m and bit is not None:
            got.setdefault(bit, set()).add((round(float(m.group(1)), 2), round(float(m.group(2)), 2)))
    assert sorted(got) == sorted(want), "drill sizes in the file %s, on the board %s" % (sorted(got), sorted(want))
    for d in want:
        near = lambda a, b: abs(a[0] - b[0]) < 0.011 and abs(a[1] - b[1]) < 0.011
        lost = [h for h in want[d] if not any(near(h, g) for g in got[d])]
        assert not lost and len(got[d]) == len(want[d]), "%.2f mm: %d holes in the file for %d pads; missing %s" % (d, len(got[d]), len(want[d]), sorted(lost)[:3])
    plunges = len(re.findall(r"^G1 Z-2\.200", text, re.M))
    holes = sum(len(v) for v in want.values())
    assert plunges == holes, "%d plunges for %d drilled pads" % (plunges, holes)
    return {"holes": holes, "sizes_mm": sorted(want), "said": [s[:120] for s in said[-1:]]}
