# board: demos/ecc83/ecc83-pp.kicad_pcb
# select: 00000000-0000-0000-0000-000054a581e5,00000000-0000-0000-0000-000054a581ea
"""Snap To Grid: two capacitors that sit off the grid are selected, a mounting hole that is also off the grid is
not.  Expect the two selected footprints moved to the nearest point of the editor's grid, turned as they were, and
everything else left where it was."""
import pcbnew

START = {"C1": (141.605, 99.695), "C2": (137.16, 125.095)}


def _at(fp):
    p = fp.GetPosition()
    return round(pcbnew.ToMM(p.x), 4), round(pcbnew.ToMM(p.y), 4)


def after_run(action):
    grid = pcbnew._Host.grid_mm
    assert 0 < grid <= 2.54, grid
    board = pcbnew.GetBoard()
    got = {}
    for ref, (x, y) in START.items():
        fp = board.FindFootprintByReference(ref)
        gx, gy = _at(fp)
        want = (round(int((x + grid / 2) / grid) * grid, 4), round(int((y + grid / 2) / grid) * grid, 4))
        assert (gx, gy) == want, f"{ref} is at {(gx, gy)}, the nearest grid point to {(x, y)} on a {grid} mm grid is {want}"
        assert (gx, gy) != (x, y), f"{ref} did not move"
        assert abs(fp.GetOrientationDegrees() - 90) < 1e-6, f"{ref} was turned"
        got[ref] = [gx, gy]
    others = {fp.GetReference(): _at(fp) for fp in board.GetFootprints() if fp.GetReference() not in START}
    holes = [at for ref, at in others.items() if at == (125.095, 93.98)]
    assert holes, f"the mounting hole that was not selected moved: {sorted(others.items())[:6]}"
    return {"grid": grid, "moved": got, "untouched": len(others)}
