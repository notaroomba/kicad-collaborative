"""Board2Pdf: keep the temporary files, press Perform with the two default templates (top, and bottom mirrored), and read
the PDFs back.  The assembly must have two pages of the board's page size; the first must hold the board outline where
the board's own Edge.Cuts lines are, in the template's grey, the second the same outline mirrored; the copper must be
recoloured and stay inside the outline, and only the frame layer (F.Fab) may reach out to the drawing sheet's border."""
import os
import re
import zlib
import pcbnew
import wx
from drive_util import click, messages

PT = 72 / 25.4
OUT = "/project/Board2Pdf"


def modal(dlg):
    panel = getattr(dlg, "panel", None)
    if panel is None:
        return wx.ID_OK
    assert panel.templatesSortOrderBox.GetItems() == ["BlackAndWhiteTop", "BlackAndWhiteBottom"], panel.templatesSortOrderBox.GetItems()
    panel.m_checkBox_delete_temp_files.SetValue(False)
    click("Perform", dlg)
    return wx.ID_CANCEL


def _streams(path):
    data = open(path, "rb").read()
    out = []
    for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        try:
            out.append(zlib.decompress(m.group(1)).decode("latin-1"))
        except zlib.error:
            out.append(m.group(1).decode("latin-1"))
    return data, [t for t in out if re.search(r"\d [ml]\b", t)]


def _media(data):
    m = re.search(rb"/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]", data)
    return float(m.group(3)), float(m.group(4))


def _lines(text):
    """Stroked two-point lines of a content stream, each as a sorted pair of points, with the stroke colour in force."""
    out, colour = [], None
    for m in re.finditer(r"([\d.]+) ([\d.]+) ([\d.]+) RG|([\d.]+) ([\d.]+) m\s+([\d.]+) ([\d.]+) l\s+S", text):
        if m.group(1):
            colour = tuple(round(float(m.group(i)), 3) for i in (1, 2, 3))
        else:
            a, b = (float(m.group(4)), float(m.group(5))), (float(m.group(6)), float(m.group(7)))
            out.append((tuple(sorted((a, b))), colour))
    return out


def _coords(text):
    pts = [(float(a), float(b)) for a, b in re.findall(r"(-?[\d.]+) (-?[\d.]+) [ml]\b", text)]
    return min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)


def _has(lines, want, colour=None):
    for (a, b), c in lines:
        if all(abs(a[i] - want[0][i]) < 0.02 and abs(b[i] - want[1][i]) < 0.02 for i in (0, 1)) and (colour is None or c == colour):
            return True
    return False


def after_run(action):
    said = messages()
    assert any("All done" in s for s in said) and not any("failed" in s for s in said), said
    board = pcbnew.GetBoard()
    edges = []
    for d in board.GetDrawings():
        if d.GetLayer() == pcbnew.Edge_Cuts:
            edges.append(((pcbnew.ToMM(d.GetStart().x), pcbnew.ToMM(d.GetStart().y)), (pcbnew.ToMM(d.GetEnd().x), pcbnew.ToMM(d.GetEnd().y))))
    assert len(edges) >= 4, "the test board has no outline"

    final = os.path.join(OUT, "ecc83-pp-Assembly.pdf")
    data, pages = _streams(final)
    w, h = _media(data)
    assert abs(w - 297 * PT) < 0.1 and abs(h - 210 * PT) < 0.1, f"the page is {w} x {h} pt, the board's sheet is A4 landscape"
    assert len(pages) == 2 and re.search(rb"/Count 2\b", data), f"{len(pages)} pages in the assembly, two templates were enabled"

    def place(p, mirrored):
        x = (297 - p[0]) if mirrored else p[0]
        return (x * PT * (w / (297 * PT)), h - p[1] * PT * (h / (210 * PT)))

    grey = (0.341, 0.341, 0.341)                               # the templates' Edge.Cuts colour, #575757
    top, bottom = _lines(pages[0]), _lines(pages[1])
    for a, b in edges:
        want = tuple(sorted((place(a, False), place(b, False))))
        assert _has(top, want, grey), f"page 1 has no grey outline line at {want}"
        assert not _has(bottom, want), "page 2 (the bottom, mirrored) holds the outline unmirrored"
        mirrored = tuple(sorted((place(a, True), place(b, True))))
        assert _has(bottom, mirrored, grey), f"page 2 has no mirrored grey outline line at {mirrored}"

    xs = [place(p, False)[0] for e in edges for p in e]
    ys = [place(p, False)[1] for e in edges for p in e]
    # the copper: recoloured to the template's #F0F0F0 and all of it on the board
    _, cu = _streams(os.path.join(OUT, "temp", "ecc83-pp-F_Cu-colored.pdf"))
    assert cu and "0.94118 0.94118 0.94118 rg" in cu[0] and "\n0 0 0 rg" not in cu[0], "the front copper was not recoloured"
    pads = sum(1 for f in board.GetFootprints() for p in f.Pads() if p.IsOnLayer(pcbnew.F_Cu))
    fills = cu[0].count("0.94118 0.94118 0.94118 rg")
    assert fills >= pads > 20, f"{fills} filled shapes for {pads} pads on the front copper"
    x0, y0, x1, y1 = _coords(cu[0])
    assert min(xs) - 1 <= x0 and x1 <= max(xs) + 1 and min(ys) - 1 <= y0 and y1 <= max(ys) + 1, "front copper is drawn outside the board outline"
    # the frame layer carries the drawing sheet; the other layers do not
    _, fab = _streams(os.path.join(OUT, "temp", "ecc83-pp-F_Fab.pdf"))
    fx0, fy0, fx1, fy1 = _coords(fab[0])
    assert fx0 < 15 * PT and fx1 > w - 15 * PT and fy0 < 15 * PT and fy1 > h - 15 * PT, "the frame layer has no drawing sheet border"
    return f"2 pages {w:.0f}x{h:.0f} pt; {len(edges)} outline lines in place on page 1 and mirrored on page 2; {fills} copper shapes recoloured for {pads} pads; drawing sheet only on F.Fab"
