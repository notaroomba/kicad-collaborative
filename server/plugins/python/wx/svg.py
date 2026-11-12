"""wx.svg: an SVG picture a plugin draws at any size.  The browser is the renderer: on a painted window the picture
is drawn straight from its text; as a bitmap with pixels it is rasterised once per size (cairosvg's stand-in)."""

import base64
import re

import wx


def _length(text, default):
    m = re.match(r"\s*([0-9.]+)\s*(px|pt|mm|cm|in)?", str(text or ""))
    if not m:
        return default
    v = float(m.group(1))
    return v * {"pt": 96 / 72, "mm": 96 / 25.4, "cm": 96 / 2.54, "in": 96.0}.get(m.group(2) or "px", 1.0)


class SVGimage:
    def __init__(self, data=b"", *a, **k):
        self._text = bytes(data).decode("utf-8", "replace") if isinstance(data, (bytes, bytearray, memoryview)) else str(data or "")
        head = re.search(r"<svg\b[^>]*>", self._text, re.S)
        tag = head.group(0) if head else ""
        box = re.search(r'viewBox\s*=\s*["\']\s*([-0-9.eE]+)[\s,]+([-0-9.eE]+)[\s,]+([-0-9.eE]+)[\s,]+([-0-9.eE]+)', tag)
        vw, vh = (float(box.group(3)), float(box.group(4))) if box else (0.0, 0.0)
        w = re.search(r'\bwidth\s*=\s*["\']([^"\']+)', tag)
        h = re.search(r'\bheight\s*=\s*["\']([^"\']+)', tag)
        self.width = _length(w.group(1), vw or 24.0) if w and "%" not in w.group(1) else (vw or 24.0)
        self.height = _length(h.group(1), vh or 24.0) if h and "%" not in h.group(1) else (vh or 24.0)
        self._url = "data:image/svg+xml;base64," + base64.b64encode(self._text.encode("utf-8")).decode("ascii")
        self._rasters = {}

    @staticmethod
    def CreateFromFile(path, units="px", dpi=96):
        with open(str(path), "rb") as fh:
            data = fh.read()
        if b"<svg" not in data:
            raise RuntimeError("not an SVG file: %s" % path)
        return SVGimage(data)

    @staticmethod
    def CreateFromBytes(data, units="px", dpi=96, do_copy=True):
        return SVGimage(data)

    CreateFromBuffer = CreateFromData = CreateFromBytes

    def _size(self, scale=None, size=None, width=-1, height=-1):
        if size is not None:
            w, h = float(size[0]), float(size[1])
            if scale is None:
                return w, h
        s = 1.0 if scale is None else float(scale)
        w = float(width) if width and width > 0 else self.width * s
        h = float(height) if height and height > 0 else self.height * s
        return w, h

    def _linked(self, w, h):
        """A bitmap that shows the picture from its text: the browser draws it at whatever size it is placed."""
        b = wx.Bitmap()
        b._src, b._w, b._h, b._blank = self._url, max(1, int(round(w))), max(1, int(round(h))), False
        return b

    def RenderToGC(self, ctx, scale=None, size=None):
        w, h = self._size(scale, size)
        ctx.DrawBitmap(self._linked(w, h), 0, 0, w, h)

    def RenderToDC(self, dc, scale=None, size=None):
        w, h = self._size(scale, size)
        dc.DrawBitmap(self._linked(w, h), 0, 0)

    def Rasterize(self, tx=0.0, ty=0.0, scale=1.0, width=-1, height=-1, stride=-1):
        return bytes(wx.Image(self.ConvertToBitmap(tx, ty, scale, width, height))._pixels())

    RasterizeToBytes = Rasterize

    def ConvertToBitmap(self, tx=0.0, ty=0.0, scale=1.0, width=-1, height=-1, stride=-1):
        """The picture as pixels (a plugin may recolour them): drawn once per size."""
        w, h = self._size(scale, None, width, height)
        key = (int(round(w)), int(round(h)))
        png = self._rasters.get(key)
        if png is None:
            try:
                import cairosvg
                png = cairosvg.svg2png(bytestring=self._text.encode("utf-8"), output_width=key[0], output_height=key[1])
            except Exception:
                png = b""
            self._rasters[key] = png
        return wx.Bitmap(png) if png else self._linked(w, h)

    def ConvertToScaledBitmap(self, size, window=None):
        return self.ConvertToBitmap(width=int(size[0]), height=int(size[1]))


__all__ = ["SVGimage"]
