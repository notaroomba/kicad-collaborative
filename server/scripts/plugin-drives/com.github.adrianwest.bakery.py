"""Bakery: accept its settings and let it copy the board's library footprints, the schematics' symbols and the 3D
models into project libraries.  Afterwards every part that came from one of KiCad's own libraries must point at the
project library, which must hold that footprint; its 3D model must be a real STEP file in the project; the schematics
must name the project libraries; and nothing else on the board may have moved or gone (parts, pads, tracks)."""
# board: demos/pic_programmer/pic_programmer.kicad_pcb
import os
import re
import wx
import pcbnew
from drive_util import messages, texts

seen = {"log": "", "done": ""}


def modal(dlg):
    kind = type(dlg).__name__
    if kind == "ConfigDialog" and "before" not in seen:
        b = pcbnew.GetBoard()
        seen["before"] = {fp.GetReference(): (str(fp.GetFPID().GetLibNickname()), str(fp.GetFPID().GetLibItemName()), fp.GetPosition().x, fp.GetPosition().y, len(list(fp.Pads()))) for fp in b.GetFootprints()}
        seen["tracks"] = len(list(b.GetTracks()))
    elif kind == "BakeryLogger":
        seen["log"] = "\n".join(texts(dlg))
    elif "Localization Complete!" in texts(dlg):
        seen["done"] = "\n".join(texts(dlg))
    return wx.ID_OK


def after_run(_action):
    assert "Localization Complete!" in seen["done"], (messages(), seen["log"][-1500:])
    copied = int(re.search(r"(\d+) footprints copied", seen["done"]).group(1))
    symbols = int(re.search(r"(\d+) symbols copied", seen["done"]).group(1))
    board = pcbnew.GetBoard()
    before = seen["before"]
    own = {"footprints"}                 # the project's own library, which has nothing to localize
    from_kicad = {ref: v for ref, v in before.items() if v[0] not in own}
    kinds = {(v[0], v[1]) for v in from_kicad.values()}
    # (the schematics may name a footprint the board does not carry: it is copied too)
    assert len(kinds) >= 15 and len(kinds) <= copied <= len(kinds) + 3, "%d footprints copied, the board uses %d from KiCad's libraries: %s" % (copied, len(kinds), re.findall(r"✗ [^\n]*", seen["log"])[:8])
    in_lib = [f for f in os.listdir("/project/MyLib.pretty") if f.endswith(".kicad_mod")]
    assert len(in_lib) == copied, sorted(in_lib)
    for f in in_lib:
        text = open(os.path.join("/project/MyLib.pretty", f), encoding="utf-8").read()
        assert text.lstrip().startswith("(footprint ") and "(pad " in text, f
    now = {fp.GetReference(): fp for fp in board.GetFootprints()}
    assert set(now) == set(before), sorted(set(now) ^ set(before))
    for ref, (lib, name, x, y, pads) in before.items():
        fp = now[ref]
        assert (fp.GetPosition().x, fp.GetPosition().y, len(list(fp.Pads()))) == (x, y, pads), "%s moved or lost pads" % ref
        nick, item = str(fp.GetFPID().GetLibNickname()), str(fp.GetFPID().GetLibItemName())
        if lib in own:
            assert nick == lib and item == name, "%s is the project's own and was renamed to %s:%s" % (ref, nick, item)
        else:
            assert nick == "MyLib" and os.path.exists("/project/MyLib.pretty/%s.kicad_mod" % item), "%s points at %s:%s" % (ref, nick, item)
    assert len(list(board.GetTracks())) == seen["tracks"], "%d tracks, there were %d" % (len(list(board.GetTracks())), seen["tracks"])
    models = [f for f in os.listdir("/project/3D Models") if f.endswith(".step")]
    assert len(models) >= 10 and all(open(os.path.join("/project/3D Models", f), encoding="utf-8", errors="replace").read(12) == "ISO-10303-21" for f in models), sorted(models)
    used = {m.m_Filename for fp in board.GetFootprints() for m in fp.Models()}
    local = {m for m in used if m.startswith("${KIPRJMOD}/3D Models/")}
    assert len(local) >= 10 and all(os.path.exists(m.replace("${KIPRJMOD}", "/project")) for m in local), sorted(used)[:6]
    sch = open("/project/pic_programmer.kicad_sch", encoding="utf-8").read()
    assert symbols >= 20 and sch.count('(lib_id "MySymbols:') >= 20 and '"MyLib:' in sch, "the schematic does not name the project libraries"
    table = open("/project/fp-lib-table", encoding="utf-8").read()
    assert '(name "MyLib")' in table and "${KIPRJMOD}/MyLib.pretty" in table, table
    lib = open("/project/MySym/MySymbols.kicad_sym", encoding="utf-8").read()
    assert lib.count("(symbol \"") >= symbols, lib[:200]
    return {"footprints_copied": copied, "symbols_copied": symbols, "models": len(models), "parts_repointed": len(from_kicad), "tracks": seen["tracks"]}
