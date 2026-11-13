# board: demos/stickhub/StickHub.kicad_pcb
"""HQ DFM: open its window, press "Quick DFM Check" (the check that runs here, in the plugin itself) and read what it
found.  The board has a 48-pin part turned by 45 degrees, tracks at every angle and one slot.

Expect, against the board file read here as text: 2 layers; 16.6 x 40.1 mm; the smallest track width (0.15 mm) with
every track looked at and every 0.15 mm track listed; the via ring of 0.1 mm on all 87 vias; 88 drilled holes on
the board's own 605.29 square mm (its outline has a notch, a narrower plug and round corners).  And against distances worked out here from the pads' and tracks' own outlines (a turned rounded
rectangle is not its bounding box): every track-to-track, track-to-pad and pad-to-pad spacing it reports is the true one
to within 3 micrometres."""
import math
import re
import pcbnew
import wx
from drive_util import fire, messages, windows


def _piece_of_pad(pad):
    """A pad as a convex outline grown by a radius: (corner points, radius), in nanometres."""
    p, s, rot = pad.GetPosition(), pad.GetSize(), math.radians(pad.GetOrientation().AsDegrees())
    hx, hy = s.x / 2.0, s.y / 2.0
    shape = pad.GetShape()
    r = hx if shape == pcbnew.PAD_SHAPE_CIRCLE else min(hx, hy) if shape == pcbnew.PAD_SHAPE_OVAL else min(hx, hy) * 2 * pad.GetRoundRectRadiusRatio() if shape == pcbnew.PAD_SHAPE_ROUNDRECT else 0.0
    r = min(r, hx, hy)
    c, sn = math.cos(rot), math.sin(rot)
    pts = [(p.x + x * c + y * sn, p.y - x * sn + y * c) for x, y in ((-hx + r, -hy + r), (hx - r, -hy + r), (hx - r, hy - r), (-hx + r, hy - r))]
    return pts, r


def _seg_point(a, b, p):
    dx, dy = b[0] - a[0], b[1] - a[1]
    n = dx * dx + dy * dy
    t = 0.0 if n == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def _cross(a, b, c, d):
    o = lambda p, q, r: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return o(a, b, c) * o(a, b, d) < 0 and o(c, d, a) * o(c, d, b) < 0


def _inside(poly, p):
    if len(poly) < 3:
        return False
    sign = 0
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        z = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        if z:
            if sign and (z > 0) != (sign > 0):
                return False
            sign = z
    return True


def _gap(one, two):
    """The distance between two outlines-with-radius; 0 when they touch or overlap."""
    (pa, ra), (pb, rb) = one, two
    ea = [(pa[i], pa[(i + 1) % len(pa)]) for i in range(len(pa) if len(pa) > 2 else max(1, len(pa) - 1))] if len(pa) > 1 else [(pa[0], pa[0])]
    eb = [(pb[i], pb[(i + 1) % len(pb)]) for i in range(len(pb) if len(pb) > 2 else max(1, len(pb) - 1))] if len(pb) > 1 else [(pb[0], pb[0])]
    if _inside(pa, pb[0]) or _inside(pb, pa[0]) or any(_cross(a, b, c, d) for a, b in ea for c, d in eb):
        return 0.0
    d = min(min(_seg_point(a, b, c), _seg_point(a, b, e), _seg_point(c, e, a), _seg_point(c, e, b)) for a, b in ea for c, e in eb)
    return max(0.0, d - ra - rb)


def _outline_area(text):
    """The board's area in square mm from its Edge.Cuts lines and arcs, chained into one loop: the area between the
    loop's corners, plus or minus the bow of each arc (exact circle segments, not a polygon)."""
    parts = []
    for m in re.finditer(r'\(gr_(line|arc)\s*\(start ([-\d.]+) ([-\d.]+)\)\s*(?:\(mid ([-\d.]+) ([-\d.]+)\)\s*)?\(end ([-\d.]+) ([-\d.]+)\)(?:(?!\(gr_).)*?\(layer "Edge\.Cuts"\)', text, re.S):
        a, b = (float(m.group(2)), float(m.group(3))), (float(m.group(6)), float(m.group(7)))
        parts.append((a, b, (float(m.group(4)), float(m.group(5))) if m.group(1) == "arc" else None))
    loop = [parts.pop(0)]
    while parts:
        end = loop[-1][1]
        k = next(i for i, (a, b, _) in enumerate(parts) if math.dist(a, end) < 1e-6 or math.dist(b, end) < 1e-6)
        a, b, mid = parts.pop(k)
        loop.append((a, b, mid) if math.dist(a, end) < 1e-6 else (b, a, mid))
    assert math.dist(loop[-1][1], loop[0][0]) < 1e-6, "the board outline is not one closed loop"
    corners = sum(a[0] * b[1] - b[0] * a[1] for a, b, _ in loop) / 2
    bows = 0.0
    for a, b, mid in loop:
        if mid is None:
            continue
        (ax, ay), (bx, by), (cx, cy) = a, mid, b
        d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
        ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
        uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
        r = math.dist((ux, uy), a)
        angle = 2 * math.asin(min(1.0, math.dist(a, b) / (2 * r)))
        side = (b[0] - a[0]) * (mid[1] - a[1]) - (b[1] - a[1]) * (mid[0] - a[0])
        bows += r * r / 2 * (angle - math.sin(angle)) * (1 if (side < 0) == (corners > 0) else -1)
    return abs(corners) + bows


def after_run(action):
    board = pcbnew.GetBoard()
    text = open(board.GetFileName(), encoding="utf-8").read()
    wins = [w for w in windows() if type(w).__name__ == "DfmMainframe"]
    assert wins and wins[-1].IsShown(), "its window did not open"
    w = wins[-1]
    fire(w.dfm_maindialog.dfm_run_button, wx.EVT_BUTTON)
    wx._run_later()
    assert any("Quick DFM check completed" in m for m in messages()), messages()[-3:]
    shown = {k: v.get("display") for k, v in w.json_analysis_map.items()}
    found = w.kicad_result

    # ---- what the board file says
    widths = [float(x) for x in re.findall(r"\n\t\((?:segment|arc)\n(?:\t\t\(.*\n)*?\t\t\(width ([\d.]+)\)", text)]
    vias = [(float(a), float(b)) for a, b in re.findall(r"\n\t\(via\n(?:\t\t.*\n)*?\t\t\(size ([\d.]+)\)\n\t\t\(drill ([\d.]+)\)", text)]
    holes = len(vias) + len(re.findall(r'\(pad "[^"]*" (?:thru_hole|np_thru_hole) ', text))
    assert shown["Layer Count"] == "2" and shown["Dimensions"] == "16.6*40.1 mm", (shown["Layer Count"], shown["Dimensions"])
    tw = found["Smallest Trace Width"]
    assert shown["Smallest Trace Width"] == f"{min(widths)}mm" and tw["checked_count"] == len(widths), (shown["Smallest Trace Width"], tw["checked_count"], len(widths))
    listed = [r for c in tw["check"] for r in c["result"]]
    assert len(listed) == sum(1 for x in widths if x == min(widths)), (len(listed), sum(1 for x in widths if x == min(widths)))
    ring = found["RingHole"]
    rings = [r for c in ring["check"] for r in c["result"]]
    assert abs(min((size - drill) / 2 for size, drill in vias) - 0.1) < 1e-9 and float(ring["display"]) == 0.1 and len(rings) == len(vias) and all(abs(float(r["value"]) - (float(r["pad_diameter"]) - float(r["hole_diameter"])) / 2) < 1e-9 for r in rings), (ring["display"], len(rings))
    density = found["Drill Hole Density"]["statistics"]
    area = _outline_area(text)
    assert density["drill_count"] == holes and abs(density["board_area_mm2"] - area) < 0.05, (density, area)

    # ---- spacings, against the outlines themselves
    by_id = {}
    for t in board.GetTracks():
        by_id[t.m_Uuid.AsString()] = t
    for fp in board.GetFootprints():
        for p in fp.Pads():
            by_id[p.m_Uuid.AsString()] = p
    u1 = {p.GetNumber(): p for fp in board.GetFootprints() if fp.GetReference() == "U1" for p in fp.Pads()}
    own = _gap(_piece_of_pad(u1["1"]), _piece_of_pad(u1["2"]))
    assert abs(own - 200000) < 5, f"this test's own geometry is off: pins 1 and 2 of U1 are {own} nm apart by it, not 0.2 mm"

    def pieces(item):
        """An item as outlines-with-radius: one for a pad or a straight track, 64 short runs along a track arc (they
        lie within a tenth of a micrometre of the true arc)."""
        if isinstance(item, pcbnew.PAD):
            return None if item.GetShape() == pcbnew.PAD_SHAPE_CUSTOM else [_piece_of_pad(item)]
        if isinstance(item, pcbnew.PCB_VIA):
            return None
        a, b, half = item.GetStart(), item.GetEnd(), item.GetWidth() / 2.0
        if isinstance(item, pcbnew.PCB_ARC):
            m = item.GetMid()
            d = 2.0 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y))
            cx = ((a.x * a.x + a.y * a.y) * (m.y - b.y) + (m.x * m.x + m.y * m.y) * (b.y - a.y) + (b.x * b.x + b.y * b.y) * (a.y - m.y)) / d
            cy = ((a.x * a.x + a.y * a.y) * (b.x - m.x) + (m.x * m.x + m.y * m.y) * (a.x - b.x) + (b.x * b.x + b.y * b.y) * (m.x - a.x)) / d
            r = math.hypot(a.x - cx, a.y - cy)
            t0, t1, tm = (math.atan2(q.y - cy, q.x - cx) for q in (a, b, m))
            sweep = (t1 - t0) % math.tau
            if (tm - t0) % math.tau > sweep:
                sweep -= math.tau
            pts = [(cx + r * math.cos(t0 + sweep * i / 64), cy + r * math.sin(t0 + sweep * i / 64)) for i in range(65)]
            return [([p, q], half) for p, q in zip(pts, pts[1:])]
        return [([(a.x, a.y), (b.x, b.y)] if (a.x, a.y) != (b.x, b.y) else [(a.x, a.y)], half)]

    checked, wrong = {}, []
    for name, keys in (("Smallest Trace Spacing", ("smallesttracespacing:tracetopadspacing", "smallesttracespacing:tracespacing")), ("SMD Spacing", ("smdspacing:smdpadspacing",))):
        rows = [r for c in found[name]["check"] for r in c["result"] if r.get("rule_key") in keys]
        n = 0
        for r in rows:
            a, b = by_id.get(r.get("info") or r.get("id")), by_id.get(r.get("related_id"))
            pa, pb = (pieces(a) if a is not None else None), (pieces(b) if b is not None else None)
            if pa is None or pb is None:
                continue
            n += 1
            true = min(_gap(x, y) for x in pa for y in pb) / 1e6
            if abs(true - float(r["value"])) > 0.003:
                wrong.append((name, r["value"], round(true, 4), r.get("layer"), type(a).__name__, type(b).__name__))
        checked[name] = (n, len(rows))
        smallest = min((float(r["value"]) for r in rows), default=None)
        assert smallest is None or abs(float(found[name]["display"]) - smallest) < 1e-9 or found[name]["display"] <= smallest, (name, found[name]["display"], smallest)
    assert all(n >= 20 for n, _ in checked.values()), f"too few spacings could be compared: {checked}"
    assert not wrong, f"{len(wrong)} of {sum(n for n, _ in checked.values())} spacings it reports are not the true distance (reported, true): {wrong[:5]}"
    return {"shown": {k: shown[k] for k in ("Layer Count", "Dimensions", "Smallest Trace Width", "RingHole", "Drill Hole Density")}, "tracks_checked": tw["checked_count"],
            "vias": len(vias), "holes": holes, "spacings_compared": {k: n for k, (n, _) in checked.items()}}
