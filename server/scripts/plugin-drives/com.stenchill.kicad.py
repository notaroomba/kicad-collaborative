"""Stenchill: press Generate Stencil and play Stenchill's service.  The plugin must upload a zip of the board's paste
and outline Gerbers with the stencil settings from its window, follow the progress stream, download the result and
save the mesh files in a dated folder beside the board.  Then View in 3D must upload the same Gerbers to the share
address and open the page the service names."""
import io
import os
import zipfile
import wx
from drive_util import multipart, archive, opened, messages, find_all, click, label_of

VIEW_PAGE = "https://www.stenchill.com/view/drive-test"
STL = b"solid stencil\nendsolid stencil\n"
SEEN = {"version": 0, "generate": [], "download": 0, "share": []}


def net(method, url, headers, body):
    if not url.startswith("https://www.stenchill.com/api/v1/"):
        return None
    what = url.split("/api/v1/", 1)[1]
    if what == "plugin/version":
        SEEN["version"] += 1
        return 200, {"latest": "0.0.1"}
    if what == "generate/stream":
        assert method == "POST" and headers.get("x-api-key"), "the upload carries no client key"
        fields, files = multipart(headers, body)
        name, data = files["file"]
        SEEN["generate"].append({"fields": fields, "files": sorted(archive(data)), "sizes": [len(b) for b in archive(data).values()]})
        stream = ('event: queued\ndata: {"position": 1, "queueDepth": 1, "etaSeconds": 2}\n\n'
                  ': ping\n\n'
                  'event: progress\ndata: {"step": 2, "total": 5, "label": "mesh", "labelText": "Building the mesh"}\n\n'
                  'event: progress\ndata: {"step": 5, "total": 5, "label": "done", "labelText": "Done"}\n\n'
                  'event: complete\ndata: {"stlPath": "drive-test_result.zip"}\n\n')
        return 200, stream, {"Content-Type": "text/event-stream"}
    if what == "download/drive-test_result.zip":
        SEEN["download"] += 1
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("stencil_front.stl", STL)
            z.writestr("CREDITS.txt", "Made with Stenchill\n")
            z.writestr("../escape.stl", STL)
        return 200, buf.getvalue(), {"Content-Type": "application/zip"}
    if what == "plugin/share":
        fields, files = multipart(headers, body)
        SEEN["share"].append(sorted(archive(files["file"][1])))
        return 200, {"url": VIEW_PAGE}
    return 404, {"detail": "no such address"}


def modal(dlg):
    wx._run_later()
    dlg._param_ctrls["thickness"].SetValue(0.25)
    click("Generate Stencil", root=dlg)
    for _ in range(6):
        wx._run_later()
    assert len(SEEN["generate"]) == 1 and SEEN["download"] == 1, "the service saw %s; the window says %r, messages %s" % (SEEN, dlg.status_text.GetLabel(), messages())
    sent = SEEN["generate"][0]
    names = [n.lower() for n in sent["files"]]
    assert any("paste" in n or n.endswith((".gtp", ".gbp")) for n in names), "no paste layer in the upload: %s" % names
    assert any("edge" in n or n.endswith((".gko", ".gm1")) for n in names), "no board outline in the upload: %s" % names
    assert all(sent["sizes"]), "an uploaded Gerber is empty"
    assert float(sent["fields"]["thickness"]) == 0.25, "the thickness set in the window was not sent: %s" % sent["fields"]
    assert sent["fields"]["enableShoulders"] in ("true", "false")
    said = dlg.result_text.GetLabel()
    assert "Saved:" in said and "stencil_front.stl" in said, "the window does not report the saved mesh: %r / %r" % (said, dlg.status_text.GetLabel())
    folders = [d for d in os.listdir("/project") if d.startswith("ecc83-pp_") and os.path.isdir(os.path.join("/project", d))]
    assert len(folders) == 1, "no dated folder beside the board: %s" % os.listdir("/project")
    inside = sorted(os.listdir(os.path.join("/project", folders[0])))
    assert "stencil_front.stl" in inside and "CREDITS.txt" in inside and "escape.stl" in inside, inside
    with open(os.path.join("/project", folders[0], "stencil_front.stl"), "rb") as f:
        assert f.read() == STL
    assert not os.path.exists("/escape.stl")
    click("View in 3D", root=dlg)
    for _ in range(6):
        wx._run_later()
    assert SEEN["share"] and any("stenchill-params.json" in n for n in SEEN["share"][0]), "the share upload lacks the settings: %s" % SEEN["share"]
    assert opened() == [VIEW_PAGE], "the 3D page was not opened: %s" % opened()
    return {"sent": sent["files"], "saved": inside, "opened": opened()}


def after_run(_action):
    assert SEEN["generate"], "Generate Stencil never reached the service"
    return dict(SEEN)
