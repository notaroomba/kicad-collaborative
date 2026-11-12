"""Copper Filler: accept its dialog as it opens and expect the zone "EmptySpace" on the chosen layer, made of the
fill shapes the plugin clipped against the board's copper with shapely."""
import pcbnew
from drive_util import messages


def after_run(_action):
    said = messages()
    bad = [m for m in said if "error" in m.lower()]
    assert not bad, "the plugin reported: %s" % bad[-1][:300]
    zones = [z for z in pcbnew.GetBoard().Zones() if z.GetZoneName() == "EmptySpace"]
    assert len(zones) == 1, "expected one zone named EmptySpace, found %d (%s)" % (len(zones), said[-2:])
    z = zones[0]
    shapes = z.Outline().OutlineCount()
    assert shapes > 100, "the zone has %d fill shapes" % shapes
    return {"layer": pcbnew.LayerName(z.GetLayer()), "fill shapes": shapes, "said": said[-1:]}
