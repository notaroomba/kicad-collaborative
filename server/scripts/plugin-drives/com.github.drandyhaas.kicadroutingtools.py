# board: server/scripts/plugin-drives/boards/six-layer-unrouted.kicad_pcb
"""KiCad Routing Tools on a small board with four unrouted nets whose straight lines cross each other: tick the four
nets on the Route tab and press Route.  The plugin's Rust router (built for the browser) must report all four routed,
and the copper it puts on the board is checked without asking the plugin: each net's two pads are joined through its
own tracks and vias, every track starts and ends on the board, and no track touches a track of another net on the
same layer closer than the tracks are wide."""
import math
import pcbnew
import wx
from drive_util import messages

MM = pcbnew.ToMM
NETS = ["SIG_A", "SIG_B", "SIG_C", "SIG_D"]


def modal(dlg):
    if type(dlg).__name__ != "RoutingDialog":
        return wx.ID_OK                                  # "Routing complete!" and the like
    assert sorted(n for n, _ in dlg.all_nets) == NETS, dlg.all_nets
    dlg.net_panel.set_selected_nets(NETS)
    assert sorted(dlg.net_panel.get_selected_nets()) == NETS
    dlg.route_btn._wx_clicked()
    wx._run_later()
    return wx.ID_CANCEL


def _dist(a, b, c, d):
    """Smallest distance between segments ab and cd."""
    def pt(p, q, r):
        vx, vy = r[0] - q[0], r[1] - q[1]
        ll = vx * vx + vy * vy
        t = 0 if ll == 0 else max(0, min(1, ((p[0] - q[0]) * vx + (p[1] - q[1]) * vy) / ll))
        return math.hypot(p[0] - q[0] - t * vx, p[1] - q[1] - t * vy)

    def o(p, q, r):
        v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
        return 0 if abs(v) < 1e-12 else (1 if v > 0 else -1)
    if o(a, b, c) != o(a, b, d) and o(c, d, a) != o(c, d, b):
        return 0.0
    return min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b))


def after_run(_action):
    said = messages()
    assert any("Successfully routed: 4 nets" in s and "Failed: 0" in s for s in said), said[-2:]
    board = pcbnew.GetBoard()
    tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
    vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
    assert len(tracks) >= 8, f"{len(tracks)} tracks on the board"

    parent = {}

    def find(k):
        parent.setdefault(k, k)
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    def join(a, b):
        parent[find(a)] = find(b)

    order = ["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu", "B.Cu"]
    segs, ends = {}, []
    for t in tracks:
        layer, net = t.GetLayerName(), t.GetNetname()
        a, b = (MM(t.GetStart().x), MM(t.GetStart().y)), (MM(t.GetEnd().x), MM(t.GetEnd().y))
        for p in (a, b):
            assert 100 <= p[0] <= 120 and 100 <= p[1] <= 120, f"a track of {net} leaves the board at {p}"
        ka, kb = (net, round(a[0], 3), round(a[1], 3), layer), (net, round(b[0], 3), round(b[1], 3), layer)
        join(ka, kb)
        ends += [(ka, a, layer, net), (kb, b, layer, net)]
        segs.setdefault(layer, []).append((net, a, b, MM(t.GetWidth())))
    for v in vias:
        p, net = (MM(v.GetPosition().x), MM(v.GetPosition().y)), v.GetNetname()
        span = order[order.index(board.GetLayerName(v.TopLayer())):order.index(board.GetLayerName(v.BottomLayer())) + 1]
        for la, lb in zip(span, span[1:]):
            join((net, round(p[0], 3), round(p[1], 3), la), (net, round(p[0], 3), round(p[1], 3), lb))

    joined = []
    for f in board.GetFootprints():
        for pad in f.Pads():
            c, size, net = pad.GetPosition(), pad.GetSize(), pad.GetNetname()
            on = [k for k, p, layer, n in ends if n == net and layer == "F.Cu" and abs(p[0] - MM(c.x)) <= MM(size.x) / 2 + 1e-6 and abs(p[1] - MM(c.y)) <= MM(size.y) / 2 + 1e-6]
            assert on, f"no track of {net} ends on pad {f.GetReference()}.{pad.GetNumber()}"
            me = (net, "pad", f.GetReference(), pad.GetNumber())
            for k in on:
                join(me, k)
            joined.append(me)
    for net in NETS:
        mine = [k for k in joined if k[0] == net]
        assert len(mine) == 2 and find(mine[0]) == find(mine[1]), f"{net}: its two pads are not joined by the routed copper"

    closest = 99.0
    for layer, ss in segs.items():
        for i, (n1, a, b, w1) in enumerate(ss):
            for n2, c, d, w2 in ss[i + 1:]:
                if n1 != n2:
                    gap = _dist(a, b, c, d) - (w1 + w2) / 2
                    closest = min(closest, gap)
                    assert gap > 0.05, f"{n1} and {n2} are {gap:.3f} mm apart on {layer}"
    return {"tracks": len(tracks), "vias": len(vias), "nets joined": NETS, "layers": sorted(segs, key=order.index), "closest other-net copper mm": round(closest, 3)}
