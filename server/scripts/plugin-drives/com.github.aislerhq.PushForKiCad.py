"""AISLER Push: press Continue and let it push the board.  AISLER's service is played by this file (a new project, the
upload, the progress it reports), so what is checked is what the plugin sends: one archive with the board's Gerbers,
drill files, the IPC-D-356 netlist, the component list and the ODB++ job, which KiCad's own ODB++ writer makes on the
desktop and the editor's makes here.  The ODB++ job is opened and compared with the board."""
# board: demos/royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb
import io
import json
import zipfile
import pcbnew
from drive_util import click, messages, multipart, archive, opened, windows, texts

sent = {"asked": []}


def net(method, url, headers, body):
    sent["asked"].append("%s %s" % (method, url.split("?")[0]))
    if method == "GET" and url.startswith("https://aisler.net/p/new.json"):
        return 200, json.dumps({"project_id": "QWERTYUI", "upload_url": "https://aisler.net/p/QWERTYUI/uploads.json"})
    if method == "POST" and url == "https://aisler.net/p/QWERTYUI/uploads.json":
        fields, files = multipart(headers, body)
        sent["title"] = fields.get("upload[title]")
        sent["zip"] = files["upload[file]"][1]
        return 200, json.dumps({"callback": "https://aisler.net/p/QWERTYUI/uploads/1.json", "redirect": "https://aisler.net/p/QWERTYUI"})
    if method == "GET" and url == "https://aisler.net/p/QWERTYUI/uploads/1.json":
        sent["polls"] = sent.get("polls", 0) + 1
        return 200, json.dumps({"progress": 100 if sent["polls"] > 1 else 70, "message": "Analysing" if sent["polls"] < 2 else "Done"})
    return 404, "{}"


def after_run(_action):
    click("Continue")
    assert "zip" in sent, "nothing was uploaded; the plugin said %s and shows %s" % (messages(), texts())
    board = pcbnew.GetBoard()
    files = archive(sent["zip"])
    names = sorted(files)
    gerbers = [n for n in names if b"%FSLAX" in files[n][:4000]]
    drills = [n for n in names if files[n].startswith(b"M48")]
    assert len(gerbers) >= 9 and len(drills) == 2, names        # 2 copper, 2 silk, 2 mask, 2 paste, outline at least
    assert files["netlist.ipc"].startswith(b"P  CODE 00"), files["netlist.ipc"][:60]
    parts = json.loads(files["components.json"])
    assert len(parts) == len(board.GetFootprints()) and {p["designator"] for p in parts} == {f.GetReference() for f in board.GetFootprints()}
    assert "odb.zip" in names, names
    odb = {n: d.decode("utf-8") for n, d in archive(files["odb.zip"]).items() if not n.endswith("/")}
    for need in ("matrix/matrix", "misc/info", "fonts/standard", "steps/pcb/stephdr", "steps/pcb/profile", "steps/pcb/eda/data", "steps/pcb/netlists/cadnet/netlist"):
        assert need in odb, sorted(odb)[:40]
    assert "UNITS=MM" in odb["misc/info"] and "ODB_VERSION_MAJOR=8" in odb["misc/info"]
    rows = [b for b in odb["matrix/matrix"].split("LAYER {")[1:]]
    kinds = [[ln.split("=", 1)[1] for ln in b.splitlines() if ln.strip().startswith("TYPE=")][0] for b in rows]
    assert kinds.count("SIGNAL") + kinds.count("POWER_GROUND") + kinds.count("MIXED") == board.GetCopperLayerCount(), kinds
    assert "DRILL" in kinds and "ROUT" in kinds and "COMPONENT" in kinds and "SOLDER_MASK" in kinds
    # the job's nets are the board's, and every pad, track and via is a subnet of one
    eda = odb["steps/pcb/eda/data"].splitlines()
    nets = [ln.split(" ")[1] for ln in eda if ln.startswith("NET ")]
    pads = sum(len(f.Pads()) for f in board.GetFootprints())
    tracks = [t for t in board.GetTracks()]
    vias = [t for t in tracks if t.GetClass() == "PCB_VIA"]
    assert sum(1 for ln in eda if ln.startswith("SNT TOP ")) == pads, "toeprints"
    assert sum(1 for ln in eda if ln == "SNT VIA") == len(vias) and sum(1 for ln in eda if ln == "SNT TRC") == len(tracks) - len(vias)
    named = {n.GetNetname() for n in board.GetNetInfo().NetsByNetcode().values() if n.GetNetCode() > 0}
    assert len(nets) == len(named) + 1 and nets[0] == "$NONE$", (len(nets), len(named))
    # the components of the job are the board's footprints, on their sides
    comps = {}
    for side in ("top", "bot"):
        text = odb.get("steps/pcb/layers/comp_+_%s/components" % side, "")
        comps[side] = [ln.split(" ")[6] for ln in text.splitlines() if ln.startswith("CMP ")]
    front = sorted(f.GetReference() for f in board.GetFootprints() if not f.IsFlipped() and len(f.Pads()))
    back = sorted(f.GetReference() for f in board.GetFootprints() if f.IsFlipped() and len(f.Pads()))
    assert sorted(c for c in comps["top"] if c in front) == front and sorted(c for c in comps["bot"] if c in back) == back, (len(comps["top"]), len(front))
    # the project's id is noted in the title block, and the order page was opened
    assert board.GetTitleBlock().GetComment(3) == "AISLER Project ID: QWERTYUI", board.GetTitleBlock().GetComment(3)
    assert opened() == ["https://aisler.net/p/QWERTYUI"], opened()
    left = [(w.GetTitle(), texts(w)) for w in windows()]
    assert not left, "the progress window should have closed: %s" % left
    return {"asked": sent["asked"], "title": sent["title"], "gerbers": len(gerbers), "drills": len(drills), "parts": len(parts), "odb_files": len(odb), "odb_layers": len(rows), "nets": len(nets)}
