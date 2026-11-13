"""HQ Component Search: type a part number, press Search and play the eda.cn part service.  The plugin must ask for
that text, list the parts the service answers with, and fill in price and stock from its supply chain answer."""
import json
import wx
from drive_util import click, messages, windows

ASKED = {"query": [], "supply": []}
PARTS = [
    {"mpn": "STM32F103C8T6", "manufacturer": "STMicroelectronics", "manufacturer_id": "ST", "package": "LQFP-48", "category": "Microcontrollers"},
    {"mpn": "STM32F103RCT6", "manufacturer": "STMicroelectronics", "manufacturer_id": "ST", "package": "LQFP-64", "category": "Microcontrollers"},
]


def net(method, url, headers, body):
    if url == "https://www.eda.cn/api/chiplet/products/queryPage":
        asked = json.loads(body)
        ASKED["query"].append(asked)
        return 200, {"total": len(PARTS), "result": [{"queryPartVO": {"part": dict(p)}} for p in PARTS]}
    if url == "https://www.eda.cn/api/chiplet/kicad/searchSupplyChain":
        ASKED["supply"].append(json.loads(body))
        return 200, {"result": [{"mpn": "STM32F103C8T6", "vendor": "hqself", "sku": "2500217622", "price": [{"rmb": 7.25}], "stock": 1234}]}
    return None


def rows(view):
    out = []
    for r in range(view.GetItemCount()):
        out.append([str(view.GetTextValue(r, c)) for c in range(view.GetColumnCount())])
    return out


def after_run(_action):
    wx._run_later()
    dlg = [w for w in windows() if hasattr(w, "search_view")]
    assert dlg, "the search window never opened: %s" % [type(w).__name__ for w in windows()]
    dlg = dlg[0]
    dlg.search_view.description.SetValue("STM32F103")
    click("Search", root=dlg)
    for _ in range(4):
        wx._run_later()
    if dlg.thread is not None:
        dlg.thread.join()
    wx._run_later()
    assert ASKED["query"] and ASKED["query"][0]["desc"] == "STM32F103" and ASKED["query"][0]["pageNum"] == 1, "the search did not ask for the typed text: %s; %s" % (ASKED, messages())
    assert ASKED["supply"] == [["ST-STM32F103C8T6", "ST-STM32F103RCT6"]], "the supply chain was not asked for the parts found: %s" % ASKED["supply"]
    got = rows(dlg.part_list_view.part_list)
    assert len(got) == 2, "the list does not show the two parts: %s" % got
    assert got[0][1] == "STM32F103C8T6" and "LQFP-48" in got[0] and "7.25" in got[0] and "1234" in got[0], "the first row is wrong: %s" % got[0]
    assert got[1][1] == "STM32F103RCT6" and got[1][6:8] == ["-", "-"], "the second row is wrong: %s" % got[1]
    assert "2" in dlg.part_list_view.result_count.GetLabel(), dlg.part_list_view.result_count.GetLabel()
    return {"rows": got, "asked": ASKED}

