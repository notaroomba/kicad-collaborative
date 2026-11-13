"""PCBWay: press the button and play PCBWay's upload address.  The plugin must send one zip holding the board's
Gerbers, drill file, netlist and component list together with the board's size and layer count, and then open the
order page the service answers with."""
import json
from drive_util import multipart, archive, opened, messages
import wx

ORDER_PAGE = "https://www.pcbway.com/QuickOrderOnline.aspx?kicad=drive-test"
GOT = []


def net(method, url, headers, body):
    if not url.startswith("https://www.pcbway.com/Common/KiCadUpFile"):
        return None
    assert method == "POST", method
    fields, files = multipart(headers, body)
    assert "upload[file]" in files, "no file in the upload: %s" % sorted(files)
    name, data = files["upload[file]"]
    inside = archive(data)
    GOT.append({"zip": name, "files": sorted(inside), "fields": fields, "sizes": {n: len(b) for n, b in inside.items()}})
    return 200, {"redirect": ORDER_PAGE}


def after_run(_action):
    wx._run_later()
    assert len(GOT) == 1, "the plugin uploaded %d times; messages: %s" % (len(GOT), messages())
    got = GOT[0]
    names = [n.lower() for n in got["files"]]
    assert any(n.endswith((".gtl", "f_cu.gbr", "f.cu.gbr")) for n in names), "no front copper Gerber in the upload: %s" % names
    assert any(n.endswith((".gko", ".gm1", "edge_cuts.gbr", "edge.cuts.gbr", ".gml")) for n in names), "no board outline in the upload: %s" % names
    assert any(n.endswith((".drl", ".xln", ".txt")) for n in names), "no drill file in the upload: %s" % names
    assert any("netlist" in n or n.endswith((".ipc", ".d356")) for n in names), "no netlist in the upload: %s" % names
    assert any(n.endswith((".csv", ".json")) for n in names), "no component list in the upload: %s" % names
    assert all(size > 0 for size in got["sizes"].values()), "an uploaded file is empty: %s" % got["sizes"]
    f = got["fields"]
    assert float(f["boardWidth"]) > 10 and float(f["boardHeight"]) > 10, "the board's size is wrong: %s" % f
    assert int(f["boardLayer"]) == 2, "the layer count is wrong: %s" % f
    assert opened() == [ORDER_PAGE], "the order page was not opened: %s" % opened()
    assert not any("rror" in m for m in messages()), messages()
    return {"uploaded": got["files"], "fields": f, "opened": opened()}
