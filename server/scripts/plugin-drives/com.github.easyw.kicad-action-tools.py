# board: demos/pic_programmer/pic_programmer.kicad_pcb
# insert: (gr_line (start 70 40) (end 90 40) (stroke (width 0.15) (type solid)) (layer "Cmts.User") (uuid "7a1c0f8e-4a57-4f0e-9d3b-2f6d5f3a9b11"))
# select: 00000000-0000-0000-0000-000054032b86,00000000-0000-0000-0000-000054032b95,7a1c0f8e-4a57-4f0e-9d3b-2f6d5f3a9b11
"""KiCad Action Tools: six commands, each worked as a person would and checked against the board file itself (read
here as text, not through the plugin interface).

Annular checker, with 0.35 mm asked for pads and 0.55 mm for vias (every via of this board has 0.5 mm): its counts of passing and failing vias and through
hole pads equal the ones worked out here from every pad's and via's size and drill, in its result window and in its
report file.
Fabrication Footprint Position: seven files in grb/, every footprint in the right one with its position from the
board's drill origin, and the totals it shows the person.
Move Selected Drawings to chosen Layer: the one selected line goes to User.Drawings, nothing else moves.
Export to DXF: it reads the saved board file line by line the way KiCad 5 wrote it; on a current board (here and on
the desktop alike) it finds nothing, so expect its confirmation and a valid, empty drawing.
Snap Selected Footprints to Grid (0.1 mm, grid origin): the two selected footprints land on the grid, by the
plugin's own rule (towards zero), and no other footprint moves.
Missing 3D models: the two footprints whose models are only .wrl files of the project are listed, and none whose
model KiCad's library has as STEP."""
import os
import re
import pcbnew
import wx
from drive_util import messages, windows, choose

LINE = "7a1c0f8e-4a57-4f0e-9d3b-2f6d5f3a9b11"
PICKED = {"00000000-0000-0000-0000-000054032b86": "C1", "00000000-0000-0000-0000-000054032b95": "C2"}
AR_PAD, AR_VIA = 0.35, 0.55
seen = {"heard": 0}


def _blocks(text, word):
    """Top-level lists of the board file that start with `word` (the file has one tab of indent per level)."""
    out, at = [], 0
    while True:
        i = text.find("\n\t(" + word, at)
        if i < 0:
            return out
        j = text.find("\n\t)", i + 1)
        out.append(text[i + 1:j + 3])
        at = j


def _file():
    """What the board file says: footprints (reference, place, side, kind, pads, models), vias, drill origin."""
    if "file" in seen:
        return seen["file"]
    text = open(pcbnew.GetBoard().GetFileName(), encoding="utf-8").read()
    aux = re.search(r"\(aux_axis_origin ([-\d.]+) ([-\d.]+)\)", text)
    fps = []
    for b in _blocks(text, "footprint"):
        at = re.search(r"\n\t\t\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)", b)
        attr = re.search(r"\n\t\t\(attr ([^)]*)\)", b)
        pads = []
        for m in re.finditer(r"\n\t\t\(pad \"([^\"]*)\" (\w+) \w+\n(.*?)\n\t\t\)", b, re.S):
            size = re.search(r"\(size ([-\d.]+) ([-\d.]+)\)", m.group(3))
            drill = re.search(r"\(drill (oval )?([-\d.]+)(?: ([-\d.]+))?", m.group(3))
            d = (float(drill.group(2)), float(drill.group(3) or drill.group(2))) if drill else (0.0, 0.0)
            pads.append({"kind": m.group(2), "size": (float(size.group(1)), float(size.group(2))), "drill": d})
        fps.append({"ref": re.search(r'\(property "Reference" "([^"]*)"', b).group(1), "uuid": re.search(r'\n\t\t\(uuid "([^"]+)"\)', b).group(1),
                    "x": float(at.group(1)), "y": float(at.group(2)), "side": "top" if '\n\t\t(layer "F.Cu")' in b else "bottom",
                    "kind": {"through_hole": "THD", "smd": "SMD"}.get(attr.group(1).strip() if attr else "", "VIRTUAL"), "pads": pads,
                    "models": re.findall(r'\n\t\t\(model "([^"]+)"', b)})
    vias = [(float(m.group(1)), float(m.group(2))) for b in _blocks(text, "via") for m in [re.search(r"\(size ([-\d.]+)\)\s*\(drill ([-\d.]+)\)", b)]]
    seen["file"] = {"fps": fps, "vias": vias, "aux": (float(aux.group(1)), float(aux.group(2))) if aux else (0.0, 0.0)}
    return seen["file"]


def _places():
    b = pcbnew.GetBoard()
    return {fp.m_Uuid.AsString(): (fp.GetPosition().x, fp.GetPosition().y) for fp in b.GetFootprints()}, {d.m_Uuid.AsString(): d.GetLayer() for d in b.GetDrawings()}


def _new_messages():
    said = messages()[seen["heard"]:]
    seen["heard"] = len(messages())
    return said


def modal(dlg):
    name = type(dlg).__name__
    if name == "Annular_Dlg":
        _file()
        dlg.m_textCtrlARP.SetValue(str(AR_PAD))
        dlg.m_textCtrlARV.SetValue(str(AR_VIA))
        seen["extra"] = float(dlg.m_textCtrlPHD.GetValue()) if dlg.m_checkBoxPHD.IsChecked() else 0.0
    elif name == "Positions_Dlg":
        seen["dir"] = dlg.m_textCtrlDir.GetValue()
        assert seen["dir"], "the output folder box starts empty"
    elif name == "Move2Layer_Dlg":
        assert dlg.m_comboBoxLayer.GetCount() == pcbnew.PCB_LAYER_ID_COUNT, dlg.m_comboBoxLayer.GetCount()
        choose(dlg.m_comboBoxLayer, "User.Drawings")
        assert dlg.m_comboBoxLayer.GetStringSelection() == "User.Drawings"
    elif name == "Snap2Grid_Dlg":
        assert dlg.m_comboBoxGrid.GetStringSelection().startswith("0.1mm") and dlg.m_radioBtnGO.GetValue(), "the window does not start on 0.1 mm from the grid origin"
    else:
        raise AssertionError(f"an unexpected window: {name}")
    seen["before"] = _places()
    return wx.ID_OK


def _annular():
    f = _file()
    extra = seen["extra"]
    via_fail = sum(1 for size, drill in f["vias"] if (size - (drill + extra)) / 2 < AR_VIA - 1e-9)
    pth = [p for fp in f["fps"] for p in fp["pads"] if p["kind"] == "thru_hole"]
    pth_fail = sum(1 for p in pth if min((p["size"][0] - (p["drill"][0] + extra)) / 2, (p["size"][1] - (p["drill"][1] + extra)) / 2) < AR_PAD - 1e-9)
    assert via_fail and pth_fail and pth_fail < len(pth), f"the limits chosen here do not split this board ({via_fail} vias, {pth_fail} of {len(pth)} pads)"
    report = open("/project/pic_programmer_AR-Check.txt").read()
    win = [w for w in windows() if type(w).__name__ == "AnnularResult_Dlg"]
    assert win and win[-1].IsShown(), "the result window is not shown"
    shown = win[-1].m_richTextResult.GetValue()
    for text, where in ((report, "the report file"), (shown, "the result window")):
        assert f"VIAS that Pass = {len(f['vias']) - via_fail}; Fails = {via_fail}" in text, (where, text[-400:])
        assert f"TH PADS that Pass = {len(pth) - pth_fail}; Fails = {pth_fail}" in text, (where, text[-400:])
        assert text.count("AR Via violation of ") == via_fail and text.count("AR PTH violation of ") == pth_fail, where
    assert "Violations found" in win[-1].m_staticTitle.GetLabel(), win[-1].m_staticTitle.GetLabel()
    return {"vias": [len(f["vias"]) - via_fail, via_fail], "through_hole_pads": [len(pth) - pth_fail, pth_fail]}


def _positions():
    f = _file()
    folder = "/project/" + seen["dir"]
    names = sorted(os.listdir(folder))
    assert names == sorted("pic_programmer_POS_" + n + ".txt" for n in ("All", "top_SMD", "bot_SMD", "top_THD", "bot_THD", "top_Virtual", "bot_Virtual")), names
    ax, ay = f["aux"]

    def rows(name):
        out = {}
        for line in open(os.path.join(folder, name), encoding="utf-8").read().splitlines():
            if line.startswith("#") or not line.strip():
                continue
            ref, kind, side = line[:14].strip(), line.split()[-1], line.split()[-2]
            x, y = float(line[64:75]), float(line[75:86])
            assert ref not in out, f"{ref} is listed twice in {name}"
            out[ref] = (x, y, side, kind)
        return out
    everything = rows("pic_programmer_POS_All.txt")
    assert len(everything) == len(f["fps"]), (len(everything), len(f["fps"]))
    count = {}
    for fp in f["fps"]:
        x, y, side, kind = everything[fp["ref"]]
        assert abs(x - (fp["x"] - ax)) < 1e-4 and abs(y + (fp["y"] - ay)) < 1e-4, f"{fp['ref']} is at {x}, {y} in the file, {fp['x'] - ax}, {-(fp['y'] - ay)} from the drill origin on the board"
        assert (side, kind) == (fp["side"], fp["kind"]), f"{fp['ref']}: {side} {kind} in the file, {fp['side']} {fp['kind']} on the board"
        count[(side, kind)] = count.get((side, kind), 0) + 1
    for (side, kind), short in ((("top", "SMD"), "top_SMD"), (("bottom", "SMD"), "bot_SMD"), (("top", "THD"), "top_THD"), (("bottom", "THD"), "bot_THD"), (("top", "VIRTUAL"), "top_Virtual"), (("bottom", "VIRTUAL"), "bot_Virtual")):
        part = rows(f"pic_programmer_POS_{short}.txt")
        assert sorted(part) == sorted(fp["ref"] for fp in f["fps"] if (fp["side"], fp["kind"]) == (side, kind)), f"{short}: {sorted(part)[:8]}"
    said = "\n".join(_new_messages())
    for text, n in (("Top TH modules", count.get(("top", "THD"), 0)), ("Bot Virtual modules", count.get(("bottom", "VIRTUAL"), 0)), ("Top SMD modules", count.get(("top", "SMD"), 0)),
                    ("TH pads", sum(len(fp["pads"]) for fp in f["fps"] if fp["kind"] == "THD"))):       # its via count compares a class with a number and is 0 on the desktop too
        assert f"{text} {n}\n" in said, f"the person is not told '{text} {n}': {said[-500:]}"
    assert count.get(("top", "THD"), 0) > 20 and count.get(("bottom", "VIRTUAL"), 0) >= 1
    return {"files": len(names), "footprints": len(everything), "counts": {f"{s} {k}": n for (s, k), n in sorted(count.items())}}


def _move():
    (fp0, dr0), (fp1, dr1) = seen["before"], _places()
    assert dr0[LINE] == pcbnew.Cmts_User and dr1[LINE] == pcbnew.Dwgs_User, f"the selected line is on layer {dr1[LINE]}"
    assert fp0 == fp1 and all(dr1[k] == v for k, v in dr0.items() if k != LINE), "something else changed"
    said = "\n".join(_new_messages())
    assert "selected drawings moved to User.Drawings layer" in said, said[-300:]
    return {"moved": 1, "to": "User.Drawings"}


def _dxf():
    said = _new_messages()
    assert any("Only SAVED board file will be exported" in s for s in said) and any("pic_programmer.dxf written" in s for s in said), said
    text = open("/project/pic_programmer.dxf").read()
    assert text.split() == ["0", "SECTION", "2", "ENTITIES", "0", "ENDSEC", "0", "EOF"], text[:300]
    # the board file it read is laid out as KiCad writes it: no line of it holds a drawing and its layer together
    board = open(pcbnew.GetBoard().GetFileName(), encoding="utf-8").read()
    assert not re.search(r"(fp_line|gr_line|fp_circle|gr_circle|fp_arc|gr_arc|fp_text|gr_text).*\(layer", board), "the board file is not in KiCad's layout"
    assert "\n\t\t(fp_line\n\t\t\t(start " in board
    return {"drawing": "valid and empty, as on the desktop with a current board file"}


def _snap():
    (fp0, dr0), (fp1, dr1) = seen["before"], _places()
    grid = pcbnew.FromMM(0.1)
    moved = {}
    for uid, (x, y) in fp0.items():
        if uid in PICKED:
            want = (int(x / grid) * grid, int(y / grid) * grid)
            assert fp1[uid] == want, f"{PICKED[uid]} is at {fp1[uid]}, the grid point is {want}"
            assert want != (x, y), f"{PICKED[uid]} was on the grid already"
            moved[PICKED[uid]] = [pcbnew.ToMM(want[0]), pcbnew.ToMM(want[1])]
        else:
            assert fp1[uid] == (x, y), "a footprint that was not selected moved"
    assert dr0 == dr1
    said = "\n".join(_new_messages())
    assert "Snapped to grid: 0.1mm" in said, said[-300:]
    return {"snapped": moved}


def _models():
    f = _file()
    project_only = sorted(fp["ref"] for fp in f["fps"] if any(m.startswith("${KIPRJMOD}") for m in fp["models"]))
    listed = open("/project/pic_programmer_missing3Dmodels.txt").read()
    got = sorted(re.findall(r"^\('([^']+)', ", listed, re.M))
    assert project_only and got == project_only, f"listed {got}, the project's own .wrl models belong to {project_only}"
    assert f"NUM of 3D missing models:{len(got)}" in listed
    said = "\n".join(_new_messages())
    assert f"NBR of 3D missing models:{len(got)}" in said, said[-300:]
    with_models = sum(1 for fp in f["fps"] if fp["models"])
    return {"checked": with_models, "missing": got}


def after_run(action):
    for start, check in (("Annular", _annular), ("Fabrication", _positions), ("Move", _move), ("Export", _dxf), ("Snap", _snap), ("Missing", _models)):
        if action.startswith(start):
            return check()
    raise AssertionError(f"an unexpected command: {action}")
