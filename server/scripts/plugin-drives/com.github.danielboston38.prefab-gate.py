# board: demos/ecc83/ecc83-pp.kicad_pcb
"""prefab-gate: its one button runs `kicad-cli pcb drc` with schematic parity on a copy of the saved board, sorts the
findings into blocking and cosmetic, and says whether the board may go to fabrication.  Here kicad-cli's check is the
editor's own Design Rules Checker and its comparison with the schematic.

Three presses, as a person fixing a board would do them:
1. The demo board as it is.  Its schematic names library footprints the board does not use for six parts (worked out
   here from the two files), so expect BLOCKED with exactly those six, and no rule violation among the blockers.
2. A track is drawn from a pad of one net onto a pad of another.  Expect more blockers, one of them a clearance
   violation or a short.
3. The track is deleted and the six footprints are given the names the schematic asks for.  Expect PASSED.
Warnings stay cosmetic throughout, and the plugin changes nothing on the board."""
import re
import kicad_web
import pcbnew
import wx
from drive_util import messages


def modal(dlg):
    return wx.ID_OK


def _verdict():
    text = messages()[-1]
    blocked = re.search(r"BLOCKED — (\d+) blocking finding", text)
    assert blocked or "PASSED — nothing blocking." in text, text[:400]
    part = text.split("cosmetic finding(s)")[0]
    return {"passed": not blocked, "blocking": re.findall(r"^  x (\w+): (.*)$", part, re.M), "cosmetic": re.findall(r"^  \. (\w+): (.*)$", text, re.M), "count": int(blocked.group(1)) if blocked else 0}


def _again():
    """A person's edit reaches the project, then they press the button again: the gate reads the saved board."""
    kicad_web.flush()
    kicad_web.load_board()
    kicad_web._actions[0].Run()
    return _verdict()


def after_run(action):
    board = pcbnew.GetBoard()
    text = open(board.GetFileName(), encoding="utf-8").read()
    sch = open(board.GetFileName().replace(".kicad_pcb", ".kicad_sch"), encoding="utf-8").read()
    on_board = dict(re.findall(r'\n\t\(footprint "([^"]+)"(?:.|\n)*?\(property "Reference" "([^"]+)"', text)[i][::-1] for i in range(text.count("\n\t(footprint ")))
    asked = {}
    for block in sch.split("\n\t(symbol\n")[1:]:
        ref = re.search(r'\(property "Reference" "([^"]+)"', block)
        fp = re.search(r'\(property "Footprint" "([^"]*)"', block)
        inst = re.search(r'\(reference "([^"]+)"\)', block)
        if ref and fp and fp.group(1) and not ref.group(1).startswith("#"):
            asked[(inst or ref).group(1)] = fp.group(1)
    differ = sorted(r for r, name in on_board.items() if r in asked and ":" in asked[r] and asked[r] != name)
    assert len(differ) == 6, f"this test reads {len(differ)} footprint names that differ from the schematic, not 6: {differ}"

    # 1. the board as it is
    first = _verdict()
    kinds = [k for k, _ in first["blocking"]]
    assert not first["passed"] and first["count"] == 6 and kinds == ["footprint_symbol_mismatch"] * 6, first["blocking"]
    for ref in differ:
        want = f"{on_board[ref]} doesn't match footprint given by symbol ({asked[ref]})"
        assert sum(1 for _, d in first["blocking"] if want in d) >= 1, f"{ref}: no finding says '{want}'"
    assert first["cosmetic"] and all(k not in ("clearance", "shorting_items", "unconnected_items") for k, _ in first["cosmetic"]), first["cosmetic"]
    before = text

    # 2. a short drawn by hand
    pads = [p for fp in board.GetFootprints() for p in fp.Pads() if p.GetNetname() and p.IsOnLayer(pcbnew.F_Cu)]
    a = pads[0]
    b = next(p for p in pads if p.GetNetname() != a.GetNetname())
    track = pcbnew.PCB_TRACK(board)
    track.SetStart(a.GetPosition())
    track.SetEnd(b.GetPosition())
    track.SetWidth(pcbnew.FromMM(0.4))
    track.SetLayer(pcbnew.F_Cu)
    track.SetNetCode(a.GetNetCode())
    board.Add(track)
    second = _verdict() if False else _again()
    more = [k for k, _ in second["blocking"] if k != "footprint_symbol_mismatch"]
    assert not second["passed"] and second["count"] > 6 and any(k in ("clearance", "shorting_items", "tracks_crossing") for k in more), second["blocking"]
    assert sum(1 for k, _ in second["blocking"] if k == "footprint_symbol_mismatch") == 6

    # 3. the short removed, the footprints named as the schematic asks
    board = pcbnew.GetBoard()
    for t in list(board.GetTracks()):
        if t.m_Uuid.AsString() == track.m_Uuid.AsString():
            board.Remove(t)
    for fp in board.GetFootprints():
        if fp.GetReference() in differ:
            lib, name = asked[fp.GetReference()].split(":", 1)
            fp.SetFPID(pcbnew.LIB_ID(lib, name))
    third = _again()
    assert third["passed"] and not third["blocking"], third["blocking"]
    assert [k for k, _ in third["cosmetic"]] == [k for k, _ in first["cosmetic"]], (third["cosmetic"], first["cosmetic"])

    # the gate itself wrote nothing: what differs from the start is this test's own renaming of six footprints
    after = open(pcbnew.GetBoard().GetFileName(), encoding="utf-8").read()
    assert after.count("\n\t(segment") == before.count("\n\t(segment") and after.count("\n\t(footprint ") == before.count("\n\t(footprint ")
    return {"as_it_is": f"BLOCKED, {first['count']} footprint mismatches", "with_a_short": f"BLOCKED, {second['count']} ({', '.join(sorted(set(more)))})", "fixed": "PASSED", "cosmetic": sorted({k for k, _ in first["cosmetic"]})}
