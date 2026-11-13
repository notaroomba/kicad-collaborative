# board: demos/ecc83/ecc83-pp.kicad_pcb
# select: 00000000-0000-0000-0000-000054a581e5,00000000-0000-0000-0000-000054a581ea
"""Bulk hide silkscreen designators: two capacitors are selected.  Expect their reference designators hidden and
every other footprint's left as it was (shown)."""
import pcbnew
import wx

seen = []


def modal(dlg):
    seen.append(type(dlg).__name__)
    return wx.ID_OK


def after_run(action):
    assert not seen, f"the plugin asked for a selection although two footprints were selected: {seen}"
    vis = {fp.GetReference(): bool(fp.Reference().IsVisible()) for fp in pcbnew.GetBoard().GetFootprints()}
    assert vis["C1"] is False and vis["C2"] is False, {r: vis[r] for r in ("C1", "C2")}
    rest = {r: v for r, v in vis.items() if r not in ("C1", "C2")}
    assert len(rest) >= 8 and all(rest.values()), f"references of footprints that were not selected were hidden: {[r for r, v in rest.items() if not v]}"
    return {"hidden": ["C1", "C2"], "left_shown": len(rest)}
