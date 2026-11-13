"""Sierra Circuits Quote, played against a stand-in for Sierra's servers built from the plugin's own code.  As a guest:
the quote window must be filled from the board (52.07 x 46.355 mm, two copper layers, 33 drilled pads, all worked
out here from the board file's text), Validate must upload the board file itself, Get Quote must send those figures
with the quantities typed, the price table must show what the service answers, and choosing a price must send that
quantity and turn time and open the order page the service names."""
import json
import re
import urllib.parse
import pcbnew
import wx
from drive_util import click, fire, messages, opened

SEEN = {"validate": [], "quote": [], "store": [], "guest": [], "other": []}
TABLE = {}
PRICE = lambda qty, days: round(100.0 / days + qty, 2)


def net(method, url, headers, body):
    path, _, query = url.partition("?")
    if path.endswith("/getkicadCurrVer"):
        return 200, {"kicadMinVer": "kicad_4.0"}
    if path.endswith("/kicadInfo"):
        tips = {k: "about " + k for k in ("electricNetTest", "outLayCop", "surFinType", "count", "density", "minAngRing", "soldMaskClr", "soldMaskFin", "soldMaskSides",
                                          "minTrcSpcInr", "minTrcSpcOut", "minTrcWidthInr", "minTrcWidthOut")}
        tips["maxQty"] = "1000"
        return 200, {"messages": {"pluginDetails": {"kicadPluginCurrVer": "kicad_4.4"}, "toolTip": tips,
                                  "supportContactDetails": {"contactnumber": "+1 000 000 0000", "email": "support@example.com", "name": "Support"}}}
    if path.endswith("/client"):
        return 200, {}
    if path.endswith("/guestEmailinfo"):
        SEEN["guest"].append(dict(urllib.parse.parse_qsl(query)))
        return 200, {"memberId": ""}
    if path.endswith("/GetFEMSGuestUserID"):
        return 200, {"FEMSGuestUserID": "guest-drive"}
    if path.endswith("/validate"):
        SEEN["validate"].append({"headers": {k.lower(): v for k, v in headers.items()}, "body": bytes(body)})
        return 200, {"filename": "ecc83-pp.kicad_pcb", "s3_file": "s3://drive/ecc83", "topImage": "top.png", "botImage": "bot.png", "bomId": "b1", "BOMValSqsQueues": [],
                     "projectId": "p1", "version": "1", "errorMessages": [], "warningMessages": []}
    if path.endswith("/quote/standardpcb"):
        q = json.loads(body)
        SEEN["quote"].append({"form": q, "query": dict(urllib.parse.parse_qsl(query))})
        qs = [int(q[k]) for k in ("boardQty1", "boardQty2", "boardQty3", "boardQty4") if q.get(k)]
        return 200, {"wmqID": "wmq-drive", "webQuoteMatrix": [{"quantity": str(n), "turntime": str(d), "testingPrice": "10", "unitPrice": str(PRICE(n, d)), "isCallUs": "0"}
                                                              for n in qs for d in (1, 2, 5, 10)]}
    if path.endswith("/store"):
        SEEN["store"].append(json.loads(body))
        return 200, {"uuid": "order-drive-1"}
    SEEN["other"].append(url)
    return None


def modal(dlg):
    if hasattr(dlg, "m_guestusername"):
        dlg.m_guestusername.SetValue("drive@example.com")
        click("Continue as a Guest", dlg)
        return dlg.GetReturnCode() or wx.ID_OK
    if hasattr(dlg, "m_quant1"):
        assert dlg.m_holeCount.GetValue() == "33", f"hole count shown: {dlg.m_holeCount.GetValue()}"
        for box, n in ((dlg.m_quant1, "5"), (dlg.m_quant2, "10"), (dlg.m_quant3, "25"), (dlg.m_quant4, "50")):
            box.SetValue(n)
        dlg.m_partnumber_value.SetValue("ECC83")
        dlg.m_revision_value.SetValue("A")
        click("Validate", dlg)
        click("GetQuote", dlg)
        return dlg.GetReturnCode() or wx.ID_OK
    if hasattr(dlg, "m_qty11"):
        TABLE.update({n: getattr(dlg, n).GetLabel() for n in ("m_qty1Text", "m_qty2Text", "m_turn1", "m_turn2", "m_qty11", "m_qty12", "m_qty21", "m_qty22")})
        dlg.m_qty22.SetValue(True)                      # second quantity, second turn time
        fire(dlg.m_qty22, wx.EVT_RADIOBUTTON)
        return wx.ID_OK
    return wx.ID_OK


def after_run(_action):
    text = open(pcbnew.GetBoard().GetFileName(), encoding="utf-8").read()
    # the board, from its file: the outline's extent, the drilled pads, the copper layers
    xs, ys = [], []
    for m in re.finditer(r"\(gr_line\s*\(start ([-\d.]+) ([-\d.]+)\)\s*\(end ([-\d.]+) ([-\d.]+)\)(?:(?!\(gr_|\(uuid).)*?\(layer \"Edge\.Cuts\"\)", text, re.S):
        xs += [float(m.group(1)), float(m.group(3))]
        ys += [float(m.group(2)), float(m.group(4))]
    assert len(xs) == 8, f"{len(xs) // 2} outline lines found in the board file"
    width_in, height_in = (max(xs) - min(xs)) / 25.4, (max(ys) - min(ys)) / 25.4
    holes = len(re.findall(r"\(drill [\d.]", text))
    coppers = len(re.findall(r'^\s*\(\d+ "[^"]+\.Cu" ', text, re.M))
    assert (round(width_in, 2), holes, coppers) == (2.05, 33, 2), (width_in, height_in, holes, coppers)

    assert SEEN["guest"] and SEEN["guest"][0].get("emailid") == "drive@example.com", SEEN["guest"]
    assert len(SEEN["validate"]) == 1, f"{len(SEEN['validate'])} uploads"
    up = SEEN["validate"][0]
    assert up["body"] == text.encode("utf-8"), f"the upload is {len(up['body'])} bytes, the board file {len(text.encode('utf-8'))}"
    assert up["headers"].get("file-name") == "ecc83-pp.kicad_pcb" and up["headers"].get("user-id") == "guest-drive", up["headers"]

    assert len(SEEN["quote"]) == 1, f"{len(SEEN['quote'])} quote requests"
    form = SEEN["quote"][0]["form"]
    assert abs(float(form["indBoardXDim"]) - width_in) < 0.006 and abs(float(form["indBoardYDim"]) - height_in) < 0.006, (form["indBoardXDim"], form["indBoardYDim"], width_in, height_in)
    assert form["layers"] == "2 Layer" and form["noOfHolesPerBoard"] == "33", (form["layers"], form["noOfHolesPerBoard"])
    assert form["innerLyrFinishCopper"] == "Not Applicable" and form["minimumTraceInnerLyr"] == "Not Applicable", form
    assert (form["partNumber"], form["partRevision"], form["email"]) == ("ECC83", "A", "drive@example.com"), form
    assert sorted(int(form[k]) for k in ("boardQty1", "boardQty2", "boardQty3", "boardQty4")) == [5, 10, 25, 50], form
    assert SEEN["quote"][0]["query"].get("user_id") == "guest-drive", SEEN["quote"][0]["query"]

    # the price table: quantities 5 and 10 across, 1 and 2 days down, with the prices answered for them
    money = lambda s: float(s.replace("$", "").replace(",", "").split("/")[0])
    assert (TABLE["m_qty1Text"], TABLE["m_qty2Text"]) == ("5", "10"), TABLE
    assert TABLE["m_turn1"].startswith("1 ") and TABLE["m_turn2"].startswith("2 "), TABLE
    shown = [money(TABLE[k]) for k in ("m_qty11", "m_qty12", "m_qty21", "m_qty22")]
    assert shown == [PRICE(5, 1), PRICE(5, 2), PRICE(10, 1), PRICE(10, 2)], (shown, TABLE)

    assert SEEN["store"], "the choice was never sent"
    order = SEEN["store"][0]
    assert order["matrix_dialog"] == {"eTest": "", "wmqId": "wmq-drive", "selectedQuantity": "10", "selectedTurntime": "2"}, order["matrix_dialog"]
    assert order["isGuest"] is True and order["userName"] == "drive@example.com" and order["s3File"] == "s3://drive/ecc83" and order["layer"] == "2", {k: order[k] for k in ("isGuest", "userName", "s3File", "layer")}
    assert opened() == ["https://app.protoexpress.com/assembly-quote?uuid=order-drive-1"], opened()
    assert not SEEN["other"], SEEN["other"]
    assert not any("error" in m.lower() for m in messages()), messages()
    return {"board in": [round(width_in, 3), round(height_in, 3)], "holes": holes, "sent": {k: form[k] for k in ("indBoardXDim", "indBoardYDim", "layers", "noOfHolesPerBoard", "minimumTrace", "minHoleSize")},
            "table": TABLE, "chosen": order["matrix_dialog"], "opened": opened()}
