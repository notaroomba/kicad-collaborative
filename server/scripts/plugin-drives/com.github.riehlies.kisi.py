"""kisi: its button builds the viewer page for the open board. Expect analysis/<board>.kisi.html beside the board, made
from the viewer page the plugin ships, with this board's own text handed over inside it."""
import base64
import gzip
import json
import os


def after_run(_action):
    page = "/project/analysis/ecc83-pp.kisi.html"
    assert os.path.exists(page), "no viewer page was written: %s" % sorted(os.listdir("/project"))
    with open(page, encoding="utf-8") as f:
        html = f.read()
    assert len(html) > 3_000_000, "the page is only %d bytes: the plugin's viewer is not in it" % len(html)
    here = os.path.dirname(__import__("kisi_kicad").__file__)
    with open(os.path.join(here, "viewer", "kisi.html"), encoding="utf-8") as f:
        template = f.read()
    marker = "null; /*@kicad-board*/"
    at = template.index(marker)
    assert html[:at] == template[:at], "the page does not start as the plugin's viewer page does"
    assert not html.startswith(marker, at), "the page has no board handed over (the marker is still empty)"
    payload, _end = json.JSONDecoder().raw_decode(html, at)
    assert payload.get("board") == "ecc83-pp", "the handed-over data names the board %r" % payload.get("board")
    boards = [f for f in payload.get("files", []) if f.get("name") == "ecc83-pp.kicad_pcb"]
    assert boards, "the board file is not handed over: %s" % [f.get("name") for f in payload.get("files", [])]
    text = gzip.decompress(base64.b64decode(boards[0]["gz"])).decode("utf-8")
    assert text.startswith("(kicad_pcb") and "Valve_ECC-83-1" in text, "the handed-over file is not this board"
    assert payload.get("page", {}).get("where") == "analysis", "the page went to %s" % payload.get("page")
    return {"page_bytes": len(html), "files": [f.get("name") for f in payload["files"]], "board_bytes": len(text)}
