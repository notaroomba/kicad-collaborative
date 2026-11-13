# file: server/tests/fixtures/vendor/easyeda_C25804.json
"""impartGUI: tick "Save local, in the project folder", type an LCSC part number and press Import, with EasyEDA's
answers replayed from a real capture.  The plugin must write a KiCad symbol library and a footprint for the part
into the project folder, and both must be offered to the project's own libraries."""
import json
import os
import wx
from drive_util import click, messages, windows, find_all, tick, label_of

ASKED = []


def net(method, url, headers, body):
    ASKED.append(url)
    if url.startswith("https://easyeda.com/api/products/C25804/components"):
        with open("/kicad/drive/files/easyeda_C25804.json", "rb") as f:
            return 200, f.read(), {"Content-Type": "application/json"}
    return 404, {"success": False}


def modal(dlg):
    wx._run_later()
    box = [c for c in find_all(wx.CheckBox, root=dlg) if "project folder" in label_of(c)][0]
    tick(box, True)
    wx._run_later()
    dlg.m_textCtrl2.SetValue("C25804")
    click("Import", root=dlg)
    for _ in range(6):
        wx._run_later()
    said = dlg.m_text.GetValue() if hasattr(dlg, "m_text") else ""
    assert ASKED and ASKED[0] == "https://easyeda.com/api/products/C25804/components", "EasyEDA was not asked for the part: %s; %s" % (ASKED, messages())
    with open("/project/EasyEDA.kicad_sym", encoding="utf-8") as f:
        sym = f.read()
    assert sym.lstrip().startswith("(kicad_symbol_lib") and "0603WAF1002T5E" in sym and "C25804" in sym, "the symbol library does not hold the part: %s" % sym[:300]
    fps = [n for n in os.listdir("/project/EasyEDA.pretty") if n.endswith(".kicad_mod")]
    assert fps == ["R0603.kicad_mod"], "the footprint was not written: %s" % fps
    with open("/project/EasyEDA.pretty/R0603.kicad_mod", encoding="utf-8") as f:
        fp = f.read()
    assert fp.count("(pad ") == 2 and "EasyEDA.3dshapes" in fp, "the footprint is not a two pad part with its model: %s" % fp[:300]
    # (the capture holds the part's STEP model but not EasyEDA's raw mesh, which the plugin needs first: no model here)
    return {"asked": ASKED, "footprints": fps, "symbol_bytes": len(sym)}

