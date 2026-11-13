# board: server/scripts/plugin-drives/boards/ground-pour-two-layer.kicad_pcb
"""TraceForge keeps a helper inside the board editor and opens its panel as a second program that talks to the helper
over a local port.  The board is 40 by 30 mm with a ground pour on both sides and one signal track, 20 mm along and
9 mm up, with a test point at each end.  Expect:

  * the export to list the signal net with its two tracks and 29 mm of length;
  * "Rotate selected items" to turn the selected footprint as one change;
  * ground stitching over the whole board on a 5 mm grid: a via at every grid point that is clear of the board edge
    and of the signal track's gap in the pour, and at no other (28 of them);
  * a via fence along the signal track, 0.8 mm copper to copper: vias every 2 mm or less along both sides, on the
    lines 1.225 mm from the track's middle (half the track, the gap, half a via), from one end to the other;
  * rounded corners at 0.5 mm: the one corner becomes an arc of that radius meeting both tracks, which end where it
    begins.

The positions are worked out here from those numbers, not read back from the plugin.  The panel's log must hold no
failed helper call."""
import math
from pathlib import Path
import wx
import pcbnew
from drive_util import windows, label_of, find_all, messages, walk

ran = {}


def modal(dlg):
    return wx.ID_CANCEL


def press(name, root=None):
    button = next((b for b in find_all(wx.Button, root=root) if label_of(b) == name and b.IsEnabled()), None)
    assert button is not None, "the panel has no '%s' button" % name
    event = wx.CommandEvent(wx.EVT_BUTTON.typeId, button.GetId())
    event.SetEventObject(button)
    button.GetEventHandler().ProcessEvent(event)


def after_run(action):
    panels = [w for w in windows() if type(w).__name__ == "TraceForgePanel"]
    if not panels and "first" not in ran:
        # the very first launch only sets up its net highlight shortcut and asks to be opened again, as on the desktop
        ran["first"] = [m for m in messages() if "open TraceForge again" in str(m)]
        assert ran["first"], "the first launch neither opened the panel nor asked to be opened again: %s" % messages()[-3:]
        return {"first_launch": "asked to be opened again after setting its shortcut"}
    assert panels, "the TraceForge panel did not open: %s" % [type(w).__name__ for w in windows()]
    if "once" in ran:
        return {"panel": label_of(panels[0])}
    ran["once"] = True
    log = Path.home() / "TraceForge" / "traceforge.log"
    start = log.stat().st_size if log.exists() else 0
    board = pcbnew.GetBoard()
    for item in list(board.GetCurrentSelection()):
        item.ClearSelected()

    press("Export paths")
    exported = sorted(Path("/project").glob("*.signal-paths.csv"))
    assert exported, "Export paths wrote no file"
    rows = [line for line in exported[0].read_text().splitlines() if line.strip()]
    assert any(r.startswith("SIG,2,29.000000,") for r in rows), "the export does not list SIG with 2 tracks and 29 mm: %s" % rows[:4]

    part = board.FindFootprintByReference("TP1")
    reference, before = part.GetReference(), part.GetOrientationDegrees()
    part.SetSelected()
    press("Rotate selected items")
    after = pcbnew.GetBoard().FindFootprintByReference(reference).GetOrientationDegrees()
    assert abs((after - before + 180) % 360 - 180) > 0.01, "%s was not rotated (%s)" % (reference, before)
    pcbnew.GetBoard().FindFootprintByReference(reference).ClearSelected()

    stitched = stitch()
    fenced = fence(stitched)
    rounded = round_corner()
    said = log.read_text()[start:] if log.exists() else ""
    assert "Traceback" not in said, "the helper failed: %s" % said[-600:]
    return {"panel": label_of(panels[0]), "exported": [r for r in rows if r.startswith("SIG")], "rotated": [reference, before, after],
            "stitching vias": len(stitched), "fence vias": len(fenced), "rounded": rounded}


TRACK = [(105.0, 115.0), (125.0, 115.0), (125.0, 106.0)]          # the signal track, corner in the middle
VIA, DRILL = 0.6, 0.3


def panel_of(kind):
    found = [w for w in walk() if type(w).__name__ == kind]
    assert found, "TraceForge has no %s" % kind
    return found[0]


def settle():
    for _ in range(6):
        wx._run_later()


def vias():
    out = {}
    for v in pcbnew.GetBoard().GetTracks():
        if v.GetClass() == "PCB_VIA":
            p = v.GetPosition()
            assert v.GetNetname() == "GND" and v.GetViaType() == pcbnew.VIATYPE_THROUGH, "a via is not a through via on GND"
            assert abs(pcbnew.ToMM(v.GetWidth(pcbnew.F_Cu)) - VIA) < 1e-6 and abs(pcbnew.ToMM(v.GetDrillValue()) - DRILL) < 1e-6, "a via is not 0.6 / 0.3 mm"
            out[(round(pcbnew.ToMM(p.x), 3), round(pcbnew.ToMM(p.y), 3))] = v
    return out


def to_track(x, y):
    """Distance from a point to the middle line of the signal track."""
    best = 1e9
    for (ax, ay), (bx, by) in zip(TRACK, TRACK[1:]):
        vx, vy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)))
        best = min(best, math.hypot(x - ax - t * vx, y - ay - t * vy))
    return best


def stitch():
    p = panel_of("StitchingPanel")
    press("Refresh board (F5)", p)
    settle()
    assert p.net.GetValue() == "GND" and (p.fields["pitch_x"].GetValue(), p.fields["pitch_y"].GetValue()) == ("5", "5"), "stitching does not start on GND at 5 mm"
    press("Preview", p)
    settle()
    assert p.apply.IsEnabled(), "the stitching preview accepted nothing: %s" % p.status.GetLabel()
    press("Apply stitching", p)
    settle()
    assert "Placed 28 stitching vias" in p.status.GetLabel(), p.status.GetLabel()
    # Every 5 mm grid point inside the board, except the ones on its edge (a via there would hang over it) and the ones
    # whose via would reach into the gap the pour leaves around the track: the gap is 0.75 mm either side of the
    # track's middle, a via is 0.3 mm in radius, and the plugin keeps 0.2 mm back from the copper's edge.
    want = {(float(x), float(y)) for x in range(105, 140, 5) for y in range(105, 130, 5) if to_track(x, y) >= 0.75 + VIA / 2 + 0.2}
    got = set(vias())
    assert len(want) == 28 and got == want, "stitching vias are not on the expected grid points: missing %s, extra %s" % (sorted(want - got), sorted(got - want))
    return got


def along(points, spacing):
    """Points along a line, the same distance apart and no further than the spacing, from one end to the other."""
    legs = [math.dist(a, b) for a, b in zip(points, points[1:])]
    n = math.ceil(sum(legs) / spacing - 1e-9)
    out = []
    for k in range(n + 1):
        d = sum(legs) * k / n
        for (a, b), leg in zip(zip(points, points[1:]), legs):
            if d <= leg + 1e-9:
                out.append((a[0] + (b[0] - a[0]) * d / leg, a[1] + (b[1] - a[1]) * d / leg))
                break
            d -= leg
    return out


def fence(stitched):
    p = panel_of("TraceFencePanel")
    for t in pcbnew.GetBoard().GetTracks():
        if t.GetClass() == "PCB_TRACK":
            t.SetSelected()
    pcbnew.Refresh()
    press("Use selected trace", p)
    settle()
    assert "SIG on F.Cu" in p.region_label.GetLabel() and "2 segments" in p.region_label.GetLabel(), p.region_label.GetLabel()
    p.fields["trace_gap"].SetValue("0.8")
    p.fields["pitch_x"].SetValue("2")
    press("Preview", p)
    settle()
    assert p.apply.IsEnabled(), "the fence preview accepted nothing: %s" % p.status.GetLabel()
    press("Apply trace fence", p)
    settle()
    for t in pcbnew.GetBoard().GetTracks():
        t.ClearSelected()
    # the two lines beside the track: 0.125 (half the track) + 0.8 (the gap) + 0.3 (half a via) from its middle,
    # meeting at the corner
    d = 0.25 / 2 + 0.8 + VIA / 2
    inner = [(105.0, 115.0 - d), (125.0 - d, 115.0 - d), (125.0 - d, 106.0)]
    outer = [(105.0, 115.0 + d), (125.0 + d, 115.0 + d), (125.0 + d, 106.0)]
    want = along(inner, 2.0) + along(outer, 2.0)
    got = sorted(set(vias()) - stitched)
    assert len(got) == len(want) == 32, "%d fence vias, %d expected" % (len(got), len(want))
    for w in want:
        near = min(math.dist(w, g) for g in got)
        assert near < 0.002, "no fence via at %.3f, %.3f (nearest is %.3f mm away)" % (w[0], w[1], near)
    return got


def round_corner():
    p = panel_of("FilletPanel")
    assert p.radius.GetValue() == "0.5", p.radius.GetValue()
    press("Preview corners", p)
    settle()
    assert p.summary.GetLabel().startswith("1 corners eligible"), p.summary.GetLabel()
    press("Round eligible corners", p)
    settle()
    assert p.summary.GetLabel().startswith("Rounded 1 corners"), p.summary.GetLabel()
    mm = lambda v: (pcbnew.ToMM(v.x), pcbnew.ToMM(v.y))
    lines, arcs = [], []
    for t in pcbnew.GetBoard().GetTracks():
        if t.GetClass() == "PCB_ARC":
            arcs.append(t)
        elif t.GetClass() == "PCB_TRACK":
            lines.append({mm(t.GetStart()), mm(t.GetEnd())})
    assert len(arcs) == 1 and len(lines) == 2, "%d arcs and %d tracks after rounding" % (len(arcs), len(lines))
    arc = arcs[0]
    assert arc.GetNetname() == "SIG" and abs(pcbnew.ToMM(arc.GetWidth()) - 0.25) < 1e-6 and arc.GetLayerName() == "F.Cu", "the arc is not SIG copper, 0.25 mm on F.Cu"
    # a 0.5 mm arc inside the corner at 125, 115: centred 0.5 mm in from both tracks, touching each 0.5 mm from the corner
    centre = (124.5, 114.5)
    close = lambda a, b: math.dist(a, b) < 0.002
    assert {True} == {any(close(e, w) for e in (mm(arc.GetStart()), mm(arc.GetEnd()))) for w in ((124.5, 115.0), (125.0, 114.5))}, "the arc ends at %s, %s" % (mm(arc.GetStart()), mm(arc.GetEnd()))
    middle = (centre[0] + 0.5 / math.sqrt(2), centre[1] + 0.5 / math.sqrt(2))
    assert close(mm(arc.GetMid()), middle), "the arc's middle is %s, not %s" % (mm(arc.GetMid()), middle)
    assert {(105.0, 115.0), (124.5, 115.0)} in lines and {(125.0, 114.5), (125.0, 106.0)} in lines, "the tracks do not end where the arc begins: %s" % lines
    return {"arc": [mm(arc.GetStart()), mm(arc.GetMid()), mm(arc.GetEnd())]}
