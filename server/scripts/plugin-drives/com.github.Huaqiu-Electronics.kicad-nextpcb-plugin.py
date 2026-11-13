"""NextPCB: play NextPCB's quote and order addresses.  Update Price must send the board's size, layer count and the
options chosen in the window and show the price the service answers with; Place Order must make the Gerber and drill
files, upload them as one zip with the same order form, and open the order page the service names."""
import json
import urllib.parse
import wx
from drive_util import multipart, archive, opened, messages, windows, click, find_all, label_of, press

ORDER_PAGE = "https://www.nextpcb.com/pcb-quote?kicad=drive-test"
SEEN = {"price": [], "order": [], "other": []}


def net(method, url, headers, body):
    if url.endswith("/ajax/valuation") or url.endswith("/public/ajax_valuation"):
        text = body.decode("utf-8")
        SEEN["price"].append(json.loads(text) if text.lstrip().startswith("{") else dict(urllib.parse.parse_qsl(text)))
        return 200, {"data": {"list": {"pcb": {"total": 23.5, "pcb_fee": 18.5, "suggest": {"deltime": [
            {"name": "3 days", "total": 23.5, "pcs_count": 5}, {"name": "24 hours", "total": 41.0, "pcs_count": 5}]}}}}}
    if "kiCadUpFile" in url or url.endswith("/External/fileQuote"):
        fields, files = multipart(headers, body)
        name, data = files["file"]
        inside = archive(data)
        SEEN["order"].append({"zip": name, "files": sorted(inside), "sizes": [len(b) for b in inside.values()], "fields": fields})
        return 200, {"url": ORDER_PAGE}
    SEEN["other"].append(url)
    return None


def table(view):
    return [[str(view.GetTextValue(r, c)) for c in range(view.GetColumnCount())] for r in range(view.GetItemCount())]


def after_run(_action):
    wx._run_later()
    frame = [w for w in windows() if type(w).__name__ == "MainFrameNextpcb"]
    assert frame, "the NextPCB window never opened"
    frame = frame[0]
    plate = lambda text: [w for w in find_all(root=frame) if type(w).__name__ == "PlateButton" and label_of(w) == text][0]
    buttons = []
    press(plate("Update Price"))
    for _ in range(4):
        wx._run_later()
    assert len(SEEN["price"]) == 1, "Update Price did not reach the service: %s; buttons %s; messages %s" % (SEEN, buttons, messages())
    form = SEEN["price"][0]
    assert str(form["blayer"]) == "2" and str(form["bcount"]) == "5", "the order form is wrong: %s" % form
    assert abs(float(form["blength"]) - 5.22) < 0.02 and abs(float(form["bwidth"]) - 4.65) < 0.02, "the board's size (cm) is wrong: %s" % form
    tables = [table(v) for v in find_all(wx.dataview.DataViewListCtrl, root=frame)]
    assert any(len(t) == 15 and ["U1", "ECC83", "Valve_ECC-83-1"] in t for t in tables), "the parts list does not show the board's 15 parts: %s" % tables
    assert any([r[:2] for r in t] == [["3days", "5"], ["24hours", "5"]] and "23.5" in t[0][2] and "41.0" in t[1][2] for t in tables), "the order summary does not show the prices answered: %s" % tables
    press(plate("Add to Cart"))
    for _ in range(8):
        wx._run_later()
    thread = getattr(frame, "_dataGenThread", None)
    if thread is not None:
        thread.join()
    for _ in range(4):
        wx._run_later()
    assert len(SEEN["order"]) == 1, "Add to Cart did not upload: %s; messages %s" % (SEEN, messages())
    order = SEEN["order"][0]
    names = [n.lower() for n in order["files"]]
    assert sum(n.endswith((".gbr", ".gtl", ".gbl", ".gto", ".gbo", ".gts", ".gbs", ".gm1", ".gko")) for n in names) >= 7, "too few Gerbers in the upload: %s" % names
    assert any(n.endswith(".drl") for n in names), "no drill file in the upload: %s" % names
    assert all(order["sizes"]), "an uploaded file is empty"
    assert order["fields"].get("blayer") == "2" and order["fields"].get("bcount") == "5", "the order form did not go with the files: %s" % order["fields"]
    assert opened() == [ORDER_PAGE], "the order page was not opened: %s" % opened()
    return {"price_form": form, "uploaded": order["files"], "opened": opened()}
