# board: demos/ecc83/ecc83-pp.kicad_pcb
"""VelaTrace: open its window, go to routing, press "Route board" and expect its own router (numpy) to lay a route
preview, drawn in the window; then report what its DRC gate says."""
from drive_util import windows, walk, label_of, messages, texts, painted


def _q(w):
    return getattr(w, "_q_owner", None)


def button(text):
    for w in walk():
        if text.lower() in label_of(w).lower() and hasattr(w, "_wx_clicked"):
            return w
    raise AssertionError("no button “%s”; the window has: %s" % (text, sorted({label_of(w)[:28] for w in walk() if label_of(w)})[:60]))


def after_run(_action):
    assert windows(), "the plugin's window did not open: %s" % messages()[-2:]
    top = next((_q(w) for w in walk() if _q(w) is not None and hasattr(_q(w), "route_button")), None)
    assert top is not None, "this is not VelaTrace's window"
    if hasattr(top, "switch_mode"):
        for b in walk():
            if label_of(b).strip().lower() in ("route", "routing") and hasattr(b, "_wx_clicked"):
                b._wx_clicked()
                break
    assert top.ready, "the plugin's own check of its router did not pass: %r (worker %r, status %r)" % (
        top._setup_error, top.worker, top.status.text())
    # VelaTrace routes unrouted boards only: delete the demo's tracks first, as its message tells a person to.
    import pcbnew
    board = pcbnew.GetBoard()
    removed = 0
    for t in list(board.GetTracks()):
        board.Remove(t)
        removed += 1
    b = button("Route board")
    assert b.IsEnabled(), "Route board is switched off: %s" % texts()[-6:]
    b._wx_clicked()
    plan = getattr(top.canvas, "plan", None)
    notes = [t for t in texts() if any(k in t for k in ("traces", "DRC", "Routing", "unavailable", "Cancelled", "rror"))][-6:]
    state = [top.status.text()[:300]] + [t[:300] for t in texts() if t and len(t) > 30][-4:]
    assert plan is not None, "no route came back: %s / %s" % (state, messages()[-3:])
    drawn = painted(top.canvas._w)
    assert any(op[0] == "line" for op in drawn), "the route preview was not drawn"
    return {"tracks_deleted_first": removed, "traces": plan.trace_count, "vias": len(plan.vias), "layers": list(plan.layers_used), "lines_drawn": sum(1 for op in drawn if op[0] == "line"),
            "notes": [n[:220] for n in notes], "said": [m[:200] for m in messages()[-3:]]}
