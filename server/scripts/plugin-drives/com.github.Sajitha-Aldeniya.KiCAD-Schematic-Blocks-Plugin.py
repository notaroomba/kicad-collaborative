# again
# copied: server/scripts/plugin-drives/boards/copied-block.txt
"""Schematic Blocks: with two wires and two labels copied in the schematic editor, name a block and press Save Block;
expect a .kicad_pack file holding exactly what was copied.  Then start the plugin again in a fresh interpreter, as on
another day: the block must still be listed, and Import Selected Block to Clipboard must put its items back into the
editor's copy buffer, ready for Paste in the schematic."""
import os
import wx
import kc_run
import kicad_web
from drive_util import windows, find_all, click, messages

NAME = "i2c-pullups"


def after_run(_action):
    wx._run_later()
    frame = [w for w in windows() if type(w).__name__ == "SchematicBlockSaverFrame"]
    assert frame, "the Schematic Block Saver window never opened"
    frame = frame[0]
    copied = wx._Clipboard._wx_read()
    if kc_run.RUN == 1:
        assert '(label "SDA"' in copied, "the editor's copy buffer did not reach the plugin"
        frame.filename_input.SetValue(NAME)
        click("Save Block", root=frame)
        assert any("saved successfully" in m for m in messages()), "no success message: %s" % messages()
        path = os.path.join(os.getcwd(), NAME + ".kicad_pack")
        with open(path, encoding="utf-8") as f:
            packed = f.read()
        assert packed == "packSch:[%s]" % copied, "the block file does not hold what was copied"
        assert any(NAME in s for s in frame.file_list.GetStrings()), "the new block is not listed"
        frame.Close()
        wx._run_later()
        return {"block": path, "bytes": len(packed)}
    rows = frame.file_list.GetStrings()
    mine = [i for i, s in enumerate(rows) if NAME in s]
    assert mine, "the saved block is gone on the second run: %s in %s" % (rows, os.getcwd())
    wx._Clipboard._wx_write('(text "something else" (at 0 0 0))')          # the person copied something else since
    assert "SDA" not in wx._Clipboard._wx_read()
    frame.file_list.SetSelection(mine[0])
    click("Import Selected Block to Clipboard", root=frame)
    assert any("imported to clipboard" in m for m in messages()), "no success message: %s" % messages()
    back = wx._Clipboard._wx_read()
    assert back.count("(wire ") == 2 and '(label "SCL"' in back, "the block did not come back into the copy buffer: %s" % back[:200]
    frame.Close()
    wx._run_later()
    return {"restored": len(back)}
