# board: demos/ecc83/ecc83-pp.kicad_pcb
"""pcb2blender: export the valve amplifier board as a .pcb3d file and open what it wrote.  Expect the archive the
Blender importer reads: pcb.wrl in pcbnew's layout (one Inline per placed 3D model, then ten layer shapes with
geometry in them), every model the board file names present under components/ as a VRML file with faces, the eight
layer drawings as SVG with the plugin's own viewBox, and the bounds record matching the board's outline."""
import os
import re
import struct
import zipfile

import pcbnew
import wx

seen = {"windows": []}


def modal(dlg):
    name = type(dlg).__name__
    seen["windows"].append(name)
    if name != "SettingsDialog":
        seen["trouble"] = name
        return wx.ID_CANCEL
    # the picker starts on the board's name in the project folder; this version of the plugin only accepts a path that
    # is already there, which the picker sees to
    seen["path"] = dlg.file_picker._text.value
    dlg.on_export(wx.CommandEvent(wx.wxEVT_COMMAND_BUTTON_CLICKED))
    return dlg.GetReturnCode()


def after_run(action):
    assert "trouble" not in seen, seen
    assert seen["windows"] == ["SettingsDialog"], seen
    OUT = seen["path"]
    assert OUT.endswith("/ecc83-pp.pcb3d"), OUT
    assert os.path.getsize(OUT) > 10000, f"the .pcb3d file holds {os.path.getsize(OUT)} bytes"
    z = zipfile.ZipFile(OUT)
    names = z.namelist()
    wrl = z.read("pcb.wrl").decode("utf-8")
    assert wrl.startswith("#VRML V2.0 utf8\nWorldInfo {"), wrl[:80]
    assert "scale 0.00254 0.00254 0.00254" in wrl[:300], wrl[:300]         # metres, as the plugin asks
    urls = re.findall(r'Inline \{\s*url "([^"]+)"', wrl)
    # every model of KiCad's library; the valve's own model (3d_shapes/ecc83.wrl) is a file this project does not hold,
    # and a model that cannot be read is left out, as pcbnew leaves it out
    named = [m.m_Filename for fp in pcbnew.GetBoard().GetFootprints() for m in fp.Models()]
    assert len(named) == 11 and len(urls) == 10 == sum(1 for n in named if ".3dshapes/" in n), (len(urls), named)
    for u in set(urls):
        assert u.startswith("components/") and u in names, (u, names)
        part = z.read(u).decode("utf-8")
        assert part.startswith("#VRML V2.0 utf8") and part.count("IndexedFaceSet") >= 1 and part.count(", -1") > 20, (u, len(part))
    layers = wrl[wrl.rindex("} ]\n  }\n"):]
    shapes = re.findall(r"point \[\n(.*?)\n\s*\]\n\s*\}\n\s*coordIndex \[\n(.*?)\n\s*\]", layers, re.S)
    assert len(shapes) == 10, len(shapes)
    faces = [s[1].count("-1") for s in shapes]
    # body, top copper, top mask, bottom copper, bottom mask, barrels and top legend all hold something on this board
    assert all(faces[i] > 100 for i in (0, 1, 3, 4, 6, 7, 8)), faces
    # the body spans the outline: its corners in metres against the board's own edges
    pts = [tuple(float(v) for v in p.split()) for p in shapes[0][0].replace("\n", " ").split(",")]
    box = pcbnew.GetBoard().GetBoardEdgesBoundingBox()
    w, h = (max(p[0] for p in pts) - min(p[0] for p in pts)) * 2.54, (max(p[1] for p in pts) - min(p[1] for p in pts)) * 2.54
    assert abs(w - pcbnew.ToMM(box.GetWidth())) < 0.3 and abs(h - pcbnew.ToMM(box.GetHeight())) < 0.3, (w, h, pcbnew.ToMM(box.GetWidth()), pcbnew.ToMM(box.GetHeight()))
    thick = (max(p[2] for p in pts) - min(p[2] for p in pts)) * 2.54
    assert 1.5 < thick < 1.61, thick
    svgs = sorted(n for n in names if n.startswith("layers/") and n.endswith(".svg"))
    assert svgs == sorted(f"layers/{l}.svg" for l in ("F_Cu", "B_Cu", "F_Paste", "B_Paste", "F_SilkS", "B_SilkS", "F_Mask", "B_Mask")), svgs
    bounds = struct.unpack("!ffff", z.read("layers/bounds"))
    assert abs(bounds[2] - (pcbnew.ToMM(box.GetWidth()) + 2)) < 0.3 and abs(bounds[0] - (pcbnew.ToMM(box.GetX()) - 1)) < 0.3, bounds
    cu = z.read("layers/F_Cu.svg").decode("utf-8")
    # the plugin re-frames each drawing in nanometres (KiCad 6's SVG unit): the drawing itself must be in that unit too
    box_nm = [round(v * 1e6) for v in bounds]
    for n in svgs:
        t = z.read(n).decode("utf-8")
        vb = [int(v) for v in re.search(r'viewBox="([^"]*)"', t).group(1).split()]
        assert all(abs(a - b) <= 1000 for a, b in zip(vb, box_nm)), (n, vb, box_nm)
        assert 'transform="scale(1000000 1000000)"' in t, (n, t[:600])
    cu = z.read("layers/B_Cu.svg").decode("utf-8")
    assert len(re.findall(r"<(?:\w+:)?(?:path|circle|polyline|polygon|rect)\b", cu)) > 20, len(cu)      # the plugin's XML writer prefixes the tags
    # a pad of the board lies inside the frame once scaled: the drawing and the frame agree
    xs = [float(v) * 1e6 for v in re.findall(r'cx="([-0-9.]+)"', cu)]
    assert xs and all(box_nm[0] < x < box_nm[0] + box_nm[2] for x in xs), (xs[:4], box_nm)
    assert any(n.startswith("boards/") for n in names) and any(n.startswith("components/") for n in names), names
    return f"{os.path.getsize(OUT)} bytes: pcb.wrl with {len(urls)} placed models from {len(set(urls))} files, faces per layer {faces}, {len(svgs)} layer drawings"
