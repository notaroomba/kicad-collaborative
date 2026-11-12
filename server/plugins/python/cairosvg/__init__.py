"""cairosvg for the web editor: the same calls (svg2png and friends), with the browser doing the drawing.

CairoSVG is a C library binding and cannot be loaded here.  The browser already has a complete SVG renderer, so svg2png
hands it the SVG at the size CairoSVG would have produced and reads the pixels back as a PNG.  Vector outputs (PDF, PS,
EPS) have no counterpart in a browser and say so; svg2svg returns the document itself.
"""
import base64 as _base64
import io as _io
import os as _os
import re as _re
import xml.etree.ElementTree as _ET

__version__ = VERSION = "2.7.1"

_UNITS = {"px": 1.0, "": 1.0, "pt": 96 / 72, "pc": 16.0, "in": 96.0, "cm": 96 / 2.54, "mm": 96 / 25.4, "q": 96 / 101.6}


def _unsupported(what):
    import pcbnew
    raise pcbnew.WebUnsupported(what)


def _length(text, dpi, whole=None):
    """An SVG length in pixels, at `dpi` for the absolute units (CairoSVG's rule)."""
    m = _re.match(r"^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$", str(text or ""))
    if not m:
        return None
    value, unit = float(m.group(1)), m.group(2).lower()
    if unit == "%":
        return value / 100 * whole if whole else None
    if unit in ("em", "rem"):
        return value * 16
    if unit == "ex":
        return value * 8
    if unit not in _UNITS:
        return None
    return value * _UNITS[unit] * (dpi / 96 if unit not in ("px", "") else 1)


def _source(bytestring, file_obj, url):
    if bytestring is not None:
        return bytestring if isinstance(bytestring, bytes) else str(bytestring).encode("utf-8")
    if file_obj is not None:
        data = file_obj.read()
        return data if isinstance(data, bytes) else str(data).encode("utf-8")
    if url is not None:
        path = str(url)
        if path.startswith("file://"):
            path = path[7:]
        elif _re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", path):
            _unsupported("cairosvg: fetching an SVG from the network (give it a file or its text)")
        with open(path, "rb") as fh:
            return fh.read()
    raise TypeError("No input. Use one of bytestring, file_obj or url.")


def _draw(svg, width, height, background, negate):
    """Have the browser's SVG renderer draw `svg` on a width x height canvas; PNG bytes come back."""
    import js
    from pyodide.ffi import run_sync
    kc = getattr(js, "__kcWx", None)
    fn = getattr(kc, "svgPng", None) if kc is not None else None
    if fn is None:
        fn = getattr(js, "__kcSvgPng", None)
    if fn is None:
        _unsupported("cairosvg: drawing an SVG outside a browser")
    out = fn(svg, int(width), int(height), str(background or ""), bool(negate))
    url = str((run_sync(out) if hasattr(out, "then") else out) or "")
    if "," not in url:
        raise ValueError("The browser could not draw this SVG" + (": " + url if url else ""))
    return _base64.b64decode(url.split(",", 1)[1])


def _deliver(data, write_to):
    if write_to is None:
        return data
    if hasattr(write_to, "write"):
        write_to.write(data)
    else:
        with open(_os.fspath(write_to), "wb") as fh:
            fh.write(data)
    return None


def svg2png(bytestring=None, *, file_obj=None, url=None, dpi=96, parent_width=None, parent_height=None, scale=1, unsafe=False,
            background_color=None, negate_colors=False, invert_images=False, write_to=None, output_width=None, output_height=None, **_):
    data = _source(bytestring, file_obj, url)
    root = _ET.fromstring(data)
    if root.tag.rsplit("}", 1)[-1] != "svg":
        raise ValueError("Not an SVG document")
    box = [float(v) for v in _re.split(r"[\s,]+", (root.get("viewBox") or "").strip()) if v] if root.get("viewBox") else []
    box = box if len(box) == 4 and box[2] > 0 and box[3] > 0 else None
    pw = float(parent_width) if parent_width else None
    ph = float(parent_height) if parent_height else None
    w = _length(root.get("width"), dpi, pw)
    h = _length(root.get("height"), dpi, ph)
    if w is None and h is None:
        w, h = (box[2], box[3]) if box else (pw or 300.0, ph or 150.0)
    elif w is None:
        w = h * box[2] / box[3] if box else (pw or 300.0)
    elif h is None:
        h = w * box[3] / box[2] if box else (ph or 150.0)
    if w <= 0 or h <= 0:
        raise ValueError("The SVG size is undefined")
    ow, oh = w * float(scale), h * float(scale)
    if output_width and output_height:
        ow, oh = float(output_width), float(output_height)
    elif output_width:
        ow, oh = float(output_width), h * float(output_width) / w
    elif output_height:
        ow, oh = w * float(output_height) / h, float(output_height)
    ow, oh = max(1, int(round(ow))), max(1, int(round(oh)))
    if not box:
        root.set("viewBox", f"0 0 {w:g} {h:g}")          # so the drawing scales with the picture, as CairoSVG scales it
    root.set("width", str(ow))
    root.set("height", str(oh))
    if output_width and output_height and not root.get("preserveAspectRatio"):
        root.set("preserveAspectRatio", "none")           # CairoSVG stretches to the size asked for
    text = _ET.tostring(root, encoding="unicode")
    return _deliver(_draw(text, ow, oh, background_color, negate_colors), write_to)


def svg2svg(bytestring=None, *, file_obj=None, url=None, write_to=None, **_):
    return _deliver(_source(bytestring, file_obj, url), write_to)


def svg2pdf(*_, **__):
    _unsupported("cairosvg.svg2pdf: writing a PDF from an SVG (the browser draws pictures only; svg2png works)")


def svg2ps(*_, **__):
    _unsupported("cairosvg.svg2ps: writing PostScript from an SVG (svg2png works)")


def svg2eps(*_, **__):
    _unsupported("cairosvg.svg2eps: writing EPS from an SVG (svg2png works)")


class _Surface:
    @classmethod
    def convert(cls, bytestring=None, **kw):
        return cls._fn(bytestring, **kw)


class PNGSurface(_Surface):
    _fn = staticmethod(svg2png)


class SVGSurface(_Surface):
    _fn = staticmethod(svg2svg)


class PDFSurface(_Surface):
    _fn = staticmethod(svg2pdf)


class PSSurface(_Surface):
    _fn = staticmethod(svg2ps)


class EPSSurface(_Surface):
    _fn = staticmethod(svg2eps)


SURFACES = {"PNG": PNGSurface, "SVG": SVGSurface, "PDF": PDFSurface, "PS": PSSurface, "EPS": EPSSurface}
