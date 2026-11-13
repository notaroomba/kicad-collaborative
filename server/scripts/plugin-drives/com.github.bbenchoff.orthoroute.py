# board: server/scripts/plugin-drives/boards/six-layer-unrouted.kicad_pcb
"""OrthoRoute on a small six-layer board with four unrouted nets, each joining two pads across the board: press Begin
Autorouting, then Apply to KiCad, and check the copper it put on the board without asking the plugin: every net's two
pads must be joined through its own tracks and vias (walked layer by layer), tracks on the inner layers must run along
the grid's axes, and no track may cross or touch a track of another net on the same layer."""
import pcbnew
from drive_util import click, messages

MM = pcbnew.ToMM
ORDER = ["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu", "B.Cu"]


def _key(x, y, layer):
    return (round(x, 3), round(y, 3), layer)


def _cross(a, b, c, d):
    """Do segments ab and cd touch?"""
    def o(p, q, r):
        v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
        return 0 if abs(v) < 1e-9 else (1 if v > 0 else -1)

    def on(p, q, r):
        return min(p[0], q[0]) - 1e-9 <= r[0] <= max(p[0], q[0]) + 1e-9 and min(p[1], q[1]) - 1e-9 <= r[1] <= max(p[1], q[1]) + 1e-9
    o1, o2, o3, o4 = o(a, b, c), o(a, b, d), o(c, d, a), o(c, d, b)
    if o1 != o2 and o3 != o4:
        return True
    return (o1 == 0 and on(a, b, c)) or (o2 == 0 and on(a, b, d)) or (o3 == 0 and on(c, d, a)) or (o4 == 0 and on(c, d, b))


def after_run(_action):
    board = pcbnew.GetBoard()
    assert not list(board.GetTracks()), "the test board starts unrouted"
    click("Begin Autorouting")
    said = messages()
    assert any("Converged" in s for s in said), said[-2:]
    assert not list(board.GetTracks()), "routes are only a preview until they are applied"
    click("Apply to KiCad")
    said = messages()
    assert any("Successfully applied" in s for s in said), said[-2:]

    tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
    vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
    assert tracks and vias, "nothing was put on the board"

    parent = {}

    def find(k):
        parent.setdefault(k, k)
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    def join(a, b):
        parent[find(a)] = find(b)

    segs = {}
    for t in tracks:
        layer = t.GetLayerName()
        a, b = (MM(t.GetStart().x), MM(t.GetStart().y)), (MM(t.GetEnd().x), MM(t.GetEnd().y))
        join((t.GetNetname(),) + _key(a[0], a[1], layer), (t.GetNetname(),) + _key(b[0], b[1], layer))
        segs.setdefault(layer, []).append((t.GetNetname(), a, b))
        if layer not in ("F.Cu", "B.Cu"):
            assert abs(a[0] - b[0]) < 1e-6 or abs(a[1] - b[1]) < 1e-6, f"a track on {layer} is not along an axis: {a} to {b}"
    for v in vias:
        p = (MM(v.GetPosition().x), MM(v.GetPosition().y))
        top, bottom = board.GetLayerName(v.TopLayer()), board.GetLayerName(v.BottomLayer())
        span = ORDER[ORDER.index(top):ORDER.index(bottom) + 1]
        assert len(span) >= 2, f"a via at {p} joins no layers ({top} to {bottom})"
        for a, b in zip(span, span[1:]):
            join((v.GetNetname(),) + _key(p[0], p[1], a), (v.GetNetname(),) + _key(p[0], p[1], b))

    nets = {}
    for f in board.GetFootprints():
        for pad in f.Pads():
            nets.setdefault(pad.GetNetname(), []).append((MM(pad.GetPosition().x), MM(pad.GetPosition().y)))
    assert sorted(nets) == ["SIG_A", "SIG_B", "SIG_C", "SIG_D"], sorted(nets)
    for net, pads in nets.items():
        assert len(pads) == 2
        a, b = [(net,) + _key(p[0], p[1], "F.Cu") for p in pads]
        assert a in parent and b in parent, f"{net}: no track starts at its pads"
        assert find(a) == find(b), f"{net}: its two pads are not joined by the routed copper"

    for layer, ss in segs.items():
        for i, (n1, a, b) in enumerate(ss):
            for n2, c, d in ss[i + 1:]:
                assert n1 == n2 or not _cross(a, b, c, d), f"{n1} and {n2} touch on {layer}: {a}-{b} and {c}-{d}"
    used = sorted({l for l in segs}, key=ORDER.index)
    return {"tracks": len(tracks), "vias": len(vias), "nets joined": sorted(nets), "layers used": used}
