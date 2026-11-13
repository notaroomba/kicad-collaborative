# board: demos/ecc83/ecc83-pp.kicad_pcb
# select: 00000000-0000-0000-0000-000054a581e5,00000000-0000-0000-0000-000054a581ea
"""Place By Sch: two capacitors are selected and the question is answered Yes.  Expect each of the two at the place
its symbol has in the schematic beside the board (read here from the schematic file itself) and turned as the symbol
is, the footprints that were not selected left alone, and the sheet's frame drawn on the board as a rectangle the
size of the schematic's paper."""
import re

import pcbnew



def _at():
    return {fp.GetReference(): (round(pcbnew.ToMM(fp.GetPosition().x), 3), round(pcbnew.ToMM(fp.GetPosition().y), 3), round(fp.GetOrientationDegrees() % 360, 3))
            for fp in pcbnew.GetBoard().GetFootprints()}


def _file_at(text):
    """reference -> (x, y, rotation) of every footprint, from the board file as it was before the run."""
    out = {}
    for m in re.finditer(r'\n\t\(footprint "[^"]*"\n(?:\t\t\(locked [^\n]*\n)?\t\t\(layer "[^"]*"\)\n\t\t\(uuid "[^"]*"\)\n\t\t\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)(.*?)\(property "Reference" "([^"]+)"', text, re.S):
        out[m.group(5)] = (round(float(m.group(1)), 3), round(float(m.group(2)), 3), round(float(m.group(3) or 0) % 360, 3))
    return out


def _symbols(text):
    """reference -> (x, y, rotation) of every placed symbol of the sheet."""
    out = {}
    for m in re.finditer(r'\n\t\(symbol\n\t\t\(lib_id "[^"]*"\)\n\t\t\(at ([-\d.]+) ([-\d.]+) ([-\d.]+)\)(.*?)\n\t\)', text, re.S):
        ref = re.search(r'\(property "Reference" "([^"]+)"', m.group(4))
        if ref:
            out[ref.group(1)] = (float(m.group(1)), float(m.group(2)), float(m.group(3)))
    return out


def after_run(action):
    board = pcbnew.GetBoard()
    with open(board.GetFileName(), encoding="utf-8") as fh:
        before = _file_at(fh.read())
    assert len(before) == 15 and before["C1"] == (141.605, 99.695, 90.0), before
    with open(board.GetFileName().replace(".kicad_pcb", ".kicad_sch"), encoding="utf-8") as fh:
        sch = fh.read()
    symbols = _symbols(sch)
    assert "C1" in symbols and "C2" in symbols and len(symbols) >= 10, sorted(symbols)
    after = _at()
    for ref in ("C1", "C2"):
        x, y, rot = symbols[ref]
        assert abs(after[ref][0] - x) < 0.002 and abs(after[ref][1] - y) < 0.002 and abs(after[ref][2] - rot % 360) < 1e-6, f"{ref} is at {after[ref]}, its symbol is at {symbols[ref]}"
        assert after[ref] != before[ref], f"{ref} did not move"
    rest = [r for r in before if r not in ("C1", "C2")]
    assert all(after[r] == before[r] for r in rest), [r for r in rest if after[r] != before[r]]
    # the sheet's frame: an A4 sheet lying on its side unless the schematic says otherwise
    paper = re.search(r'\(paper "([^"]+)"', sch).group(1)
    size = {"A4": (297.0, 210.0), "A3": (420.0, 297.0)}[paper]
    rects = [g for g in board.GetDrawings() if g.GetClass() == "PCB_SHAPE" and g.GetShape() == pcbnew.SHAPE_T_RECT and g.GetLayer() == pcbnew.Dwgs_User]
    frames = [(round(pcbnew.ToMM(g.GetStart().x), 2), round(pcbnew.ToMM(g.GetStart().y), 2), round(pcbnew.ToMM(g.GetEnd().x), 2), round(pcbnew.ToMM(g.GetEnd().y), 2)) for g in rects]
    assert (0.0, 0.0, size[0], size[1]) in frames, f"no {paper} frame among the rectangles drawn: {frames}"
    return {"placed": {r: list(after[r]) for r in ("C1", "C2")}, "untouched": len(rest), "frame": list(size)}
