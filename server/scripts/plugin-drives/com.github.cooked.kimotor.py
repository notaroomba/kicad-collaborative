"""KiMotor: ask for wire terminals (they come from KiCad's footprint libraries), press Generate, and expect a motor:
coil tracks and arcs, vias, the outline, and one library footprint per phase."""
import pcbnew
from drive_util import click, messages, named, choose


def after_run(_action):
    board = pcbnew.GetBoard()
    before = len(list(board.GetTracks()))
    choose(named("m_cbTP"), "THT")
    click("Generate")
    wires = [f for f in board.GetFootprints() if "SolderWire" in f.GetFPIDAsString()]
    tracks = len(list(board.GetTracks())) - before
    assert len(wires) == 3, "expected three wire terminals from the Connector_Wire library, found %d (%s)" % (len(wires), messages()[-2:])
    assert tracks > 300, "expected the coils' tracks, found %d new ones" % tracks
    assert all(p.GetNetname() == "coil" for f in wires for p in f.Pads()), "the terminals' pads are not on the coil net"
    return {"terminals": [f.GetFPIDAsString() for f in wires][:1], "new tracks and vias": tracks}
