# board: demos/ecc83/ecc83-pp.kicad_pcb
"""Hide References: the board shows its reference designators.  Expect every one hidden after the first press, and
every one shown again after the second (the plugin shows them when all are hidden)."""
import pcbnew


def _visible():
    return {fp.GetReference(): bool(fp.Reference().IsVisible()) for fp in pcbnew.GetBoard().GetFootprints()}


def after_run(action):
    first = _visible()
    assert len(first) >= 10 and not any(first.values()), f"references still shown after the first press: {[r for r, v in first.items() if v]}"
    import kicad_web
    kicad_web._actions[0].Run()
    second = _visible()
    assert all(second.values()), f"references still hidden after the second press: {[r for r, v in second.items() if not v]}"
    return {"footprints": len(first), "hidden_then_shown": True}
