# board: demos/ecc83/ecc83-pp.kicad_pcb
"""Oktizer with nothing selected: every round through-hole pad of the board becomes an octagon.  Expect each pad
that was round or oval in the board file now a custom-shaped pad whose one polygon has eight corners on the pad's own
bounding square, at the same place with the same hole, and a small copper zone (the fillet) on the pad's net
wherever a track runs into such a pad."""
import re

import pcbnew


def after_run(action):
    board = pcbnew.GetBoard()
    with open(board.GetFileName(), encoding="utf-8") as fh:
        was = fh.read()
    round_before = len(re.findall(r'\(pad "[^"]*" thru_hole (?:circle|oval)', was))
    zones_before = len(re.findall(r"^\t\(zone\b", was, re.M))
    assert round_before >= 20, round_before
    octagons, squares, wrong = 0, 0, []
    for fp in board.GetFootprints():
        for p in fp.Pads():
            if p.GetAttribute() != pcbnew.PAD_ATTRIB_PTH or p.GetShape() != pcbnew.PAD_SHAPE_CUSTOM:
                continue
            prims = p.GetPrimitives()
            if len(prims) != 1:
                continue
            pts = [(float(q[1]), float(q[2])) for q in pcbnew._kid(prims[0], "pts")[1:]]
            if len(pts) == 4:
                squares += 1                           # a square pad stays a square (drawn as its own polygon)
                continue
            w = max(abs(x) for x, y in pts) * 2
            h = max(abs(y) for x, y in pts) * 2
            ok = (len(pts) == 8 and str(prims[0][0]) == "gr_poly"
                  and all(abs(abs(x) - w / 2) < 1e-4 or abs(abs(y) - h / 2) < 1e-4 for x, y in pts)
                  and len({(round(x, 4), round(y, 4)) for x, y in pts}) == 8
                  and pcbnew.ToMM(p.GetDrillSize().x) > 0.5 and w > pcbnew.ToMM(p.GetDrillSize().x))
            if ok:
                octagons += 1
            else:
                wrong.append((fp.GetReference(), p.GetPadName(), pts))
    assert not wrong, f"pads that are not clean octagons: {wrong[:4]}"
    assert octagons == round_before, f"{octagons} octagonal pads, the board had {round_before} round and oval through-hole pads"
    left = [(fp.GetReference(), p.GetPadName()) for fp in board.GetFootprints() for p in fp.Pads()
            if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH and p.GetShape() == pcbnew.PAD_SHAPE_CIRCLE]
    assert not left, f"round pads left: {left[:6]}"
    zones = list(board.Zones())
    added = len(zones) - zones_before
    assert added >= 10, f"{added} fillet zones were added"
    nets = {n.GetNetname() for n in (z.GetNet() for z in zones[zones_before:]) if n is not None}
    assert nets and "" not in nets, f"fillets without a net: {nets}"
    return {"octagons": octagons, "squares": squares, "fillet_zones": added, "nets": len(nets)}
