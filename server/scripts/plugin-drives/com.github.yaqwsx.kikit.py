# board: server/scripts/plugin-drives/boards/empty.kicad_pcb
# sibling: demos/ecc83/ecc83-pp.kicad_pcb
"""KiKit: "Panelize PCB" is run from an empty board, as KiKit asks.  The input is another board of the project; the
layout is a 2 x 2 grid with fixed tabs, mouse bites and rails.  KiKit's own panelization (shapely) builds the panel file
and the dialog puts the panel on the open board: four copies of every footprint, a new outline, the mouse bite holes."""
import os

import pcbnew

import sys
import traceback

import wx

_real_message = wx.MessageDialog.__init__


def _message(self, *a, **k):          # KiKit reports a failure in a message box: keep the traceback for the log
    if sys.exc_info()[0] is not None:
        traceback.print_exc()
    _real_message(self, *a, **k)


wx.MessageDialog.__init__ = _message

SOURCE = "/project/ecc83-pp.kicad_pcb"
OUT = "/project/ecc83-panel.kicad_pcb"
_state = {}


def modal(dlg):
    sections = getattr(dlg, "sections", None)
    if not sections or "Input" not in sections:
        return None

    def put(section, name, value):
        sections[section].items[name].setValue(value)
        sections[section].onChange() if hasattr(sections[section], "onChange") else None

    put("Input", "Input file", SOURCE)
    put("Output", "Output file", OUT)
    put("Layout", "type", "grid")
    put("Layout", "rows", 2)
    put("Layout", "cols", 2)
    put("Layout", "hspace", "2mm")
    put("Layout", "vspace", "2mm")
    put("Tabs", "type", "fixed")
    put("Tabs", "hwidth", "5mm")
    put("Tabs", "vwidth", "5mm")
    put("Cuts", "type", "mousebites")
    put("Framing", "type", "railstb")
    if hasattr(dlg, "OnChange"):
        dlg.OnChange()
    dlg.okButton._wx_clicked()
    _state["ran"] = True
    return None


def after_run(action):
    if "anel" not in str(action or "Panelize"):
        return {"skipped": "driven only for Panelize PCB"}
    assert _state.get("ran"), "the Panelize dialog did not open"
    assert os.path.isfile(OUT), "KiKit wrote no panel file"
    src = pcbnew.LoadBoard(SOURCE)
    panel = pcbnew.LoadBoard(OUT)
    n_src, n_panel = len(list(src.GetFootprints())), len(list(panel.GetFootprints()))
    holes = [f for f in panel.GetFootprints() if f.GetReference().startswith("KiKit_MB_")]
    assert holes, "the mouse bites drilled no holes"
    assert all(p.GetDrillSize().x > 0 for f in holes for p in f.Pads()), "a mouse bite hole has no drill"
    assert n_panel - len(holes) == 4 * n_src, "the panel file has %d footprints beside %d holes, four boards have %d" % (n_panel - len(holes), len(holes), 4 * n_src)
    board = pcbnew.GetBoard()
    on_board = len(list(board.GetFootprints()))
    assert on_board == n_panel, "the open board got %d of the panel's %d footprints" % (on_board, n_panel)
    edge = [d for d in board.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts]
    assert edge, "the panel on the open board has no outline"
    box = panel.ComputeBoundingBox(True)
    sbox = src.ComputeBoundingBox(True)
    assert box.GetWidth() > 2 * sbox.GetWidth() and box.GetHeight() > 2 * sbox.GetHeight(), "the panel is not larger than two boards each way"
    return {"footprints_source": n_src, "footprints_panel": n_panel, "mouse_bite_holes": len(holes), "outline_items": len(edge),
            "panel_mm": [round(pcbnew.ToMM(box.GetWidth()), 2), round(pcbnew.ToMM(box.GetHeight()), 2)],
            "tracks": len(list(board.GetTracks())), "zones": len(list(board.Zones()))}
