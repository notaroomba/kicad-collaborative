# board: demos/ecc83/ecc83-pp.kicad_pcb
# pick: saved
"""Stretch: "to SVG" hands over a drawing of the board; the person changes it in a drawing program and "to PCB" reads it
back.  Here the changed drawing has one track bent in two, another track made wider, capacitor C2 moved 10 mm to the
right and one corner of the ground zone pulled in.  Expect exactly those changes on the board (the plugin asks for the
drawing, and its rewritten board file is carried into the board), and everything else as it was: the same footprints
with their ids and fields, 58 of the 59 tracks untouched."""
import os
import re

import pcbnew

from drive_util import messages

PX = 96 / 25.4
seen = {}


def _tracks():
    return {t.m_Uuid.AsString(): (t.GetStart().x, t.GetStart().y, t.GetEnd().x, t.GetEnd().y, t.GetWidth(), t.GetNetname(), t.GetLayer())
            for t in pcbnew.GetBoard().GetTracks()}


def _parts():
    return {fp.GetReference(): (fp.m_Uuid.AsString(), fp.GetPosition().x, fp.GetPosition().y, fp.GetOrientationDegrees(), fp.GetValue(), len(fp.Pads()))
            for fp in pcbnew.GetBoard().GetFootprints()}


def picked(name, data):
    """The person's changes to the drawing, made as a drawing program would write them."""
    assert name == "out.svg", "asked for %s" % name
    svg = data.decode("utf-8")
    paths = re.findall(r'<path[^>]*type="segment"[^>]*>(?:</path>)?', svg)
    assert len(paths) == 59, "the drawing has %d tracks" % len(paths)
    first, second = paths[0], paths[1]
    d = re.search(r'd="M ([\d.]+),([\d.]+) ([\d.]+),([\d.]+)"', first)
    x1, y1, x2, y2 = (float(v) for v in d.groups())
    seen["bent"] = [round(v / PX, 3) for v in (x1, y1, x2, y2)]
    mid = (140.6 * PX, 98.5 * PX)
    a = first.replace(d.group(0), 'd="M %r,%r %r,%r"' % (x1, y1, mid[0], mid[1]))
    b = first.replace(d.group(0), 'd="M %r,%r %r,%r"' % (mid[0], mid[1], x2, y2))
    svg = svg.replace(first, a + ("" if first.endswith("</path>") else "</path>") + b, 1)
    d2 = re.search(r'd="M ([\d.]+),([\d.]+) ([\d.]+),([\d.]+)"', second)
    seen["widened"] = [round(float(v) / PX, 3) for v in d2.groups()]
    svg = svg.replace(second, second.replace("stroke-width:0.8mm", "stroke-width:1.2mm"), 1)
    c2 = re.search(r'(<g [^>]*path="/00000000-0000-0000-0000-00004549f3be"[^>]*transform="translate\()([\d.]+),([\d.]+)\)', svg)
    assert c2, "C2 is not in the drawing"
    svg = svg.replace(c2.group(0), "%s%r,%s)" % (c2.group(1), float(c2.group(2)) + 10 * PX, c2.group(3)), 1)
    zone = re.search(r'(<path d="M\s+[\d.]+,[\d.]+ [\d.]+,)([\d.]+)( [^"]*Z"[^>]*type="zone")', svg)
    assert zone, "the zone is not in the drawing"
    svg = svg.replace(zone.group(0), "%s%r%s" % (zone.group(1), 92.5 * PX, zone.group(3)), 1)
    seen["edited"] = True
    return svg.encode("utf-8")


def after_run(action):
    if "SVG" in str(action):
        assert os.path.getsize("/project/out.svg") > 50000, "no drawing was made"
        seen["tracks"], seen["parts"] = _tracks(), _parts()
        return {"drawing": os.path.getsize("/project/out.svg")}
    assert seen.get("edited"), "the plugin never asked for the changed drawing; %s" % messages()
    board = pcbnew.GetBoard()
    before, now = seen["tracks"], _tracks()
    mm = pcbnew.ToMM
    # the bent track: the old one moved to the first half, a copy of it added for the second
    gone = [k for k in before if k not in now]
    added = [k for k in now if k not in before]
    changed = [k for k in now if k in before and now[k] != before[k]]
    assert not gone and len(added) == 1 and len(changed) == 2, "tracks removed %d, added %d, changed %d" % (len(gone), len(added), len(changed))
    x1, y1, x2, y2 = seen["bent"]
    ends = lambda t: sorted([(round(mm(t[0]), 3), round(mm(t[1]), 3)), (round(mm(t[2]), 3), round(mm(t[3]), 3))])
    halves = sorted([ends(now[k]) for k in added + changed if now[k][4] == pcbnew.FromMM(0.8)])
    assert halves == sorted([sorted([(x1, y1), (140.6, 98.5)]), sorted([(140.6, 98.5), (x2, y2)])]), "the bent track is %s" % halves
    new = now[added[0]]
    assert new[5] and new[5] == before[changed[0]][5] and new[6] == pcbnew.B_Cu, "the added piece is on net %r, layer %s" % (new[5], new[6])
    wide = [k for k in changed if now[k][4] == pcbnew.FromMM(1.2)]
    assert len(wide) == 1 and now[wide[0]][:4] == before[wide[0]][:4] and ends(now[wide[0]]) == sorted([tuple(seen["widened"][:2]), tuple(seen["widened"][2:])]), \
        "the widened track: %s" % [now[k] for k in changed]
    # C2 moved, nothing else did, and every footprint is still itself
    parts = _parts()
    assert set(parts) == set(seen["parts"]) and len(parts) == 15
    for ref, was in seen["parts"].items():
        if ref == "C2":
            assert abs(parts[ref][1] - was[1] - pcbnew.FromMM(10)) <= 2000 and abs(parts[ref][2] - was[2]) <= 2000 and parts[ref][3] == was[3], \
                "C2 went from %.3f, %.3f to %.3f, %.3f" % (mm(was[1]), mm(was[2]), mm(parts[ref][1]), mm(parts[ref][2]))
            assert (parts[ref][0], parts[ref][4], parts[ref][5]) == (was[0], was[4], was[5]), "C2 is no longer the same footprint"
        else:
            assert parts[ref] == was, "%s changed: %s -> %s" % (ref, was, parts[ref])
    pad = board.FindFootprintByReference("C2").Pads()[0].GetPosition()
    assert abs(pad.x - board.FindFootprintByReference("C2").GetPosition().x) < pcbnew.FromMM(8), "C2's pads did not come along"
    # the zone corner
    zone = list(board.Zones())[0]
    corners = sorted((round(mm(zone.GetCornerPosition(i).x), 3), round(mm(zone.GetCornerPosition(i).y), 3)) for i in range(zone.GetNumCorners()))
    assert corners == sorted([(172.085, 135.89), (172.085, 92.5), (122.555, 91.44), (122.555, 135.89)]), "the zone's corners are %s" % corners
    assert zone.GetNetname() == "GND" and zone.GetMinThickness() == pcbnew.FromMM(0.381), "the zone lost its settings"
    assert len(list(board.GetDrawings())) == 4, "the board outline changed"
    return {"tracks": len(now), "bent": halves, "C2": [round(mm(parts["C2"][1]), 3), round(mm(parts["C2"][2]), 3)], "zone": corners}
