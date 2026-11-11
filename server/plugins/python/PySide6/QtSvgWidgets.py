"""PySide6.QtSvgWidgets for the web editor: an SVG picture shown as an image."""

import os

import wx

from .QtWidgets import QWidget


class QSvgWidget(QWidget):
    def __init__(self, *a, **k):
        path = next((x for x in a if isinstance(x, str)), "")
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))
        self._img = wx._el("img")
        self._img.style.maxWidth = "100%"
        self._img.style.maxHeight = "100%"
        self._img.style.display = "block"
        self._img.style.margin = "auto"
        self._w.el.appendChild(self._img)
        if path:
            self.load(path)

    def load(self, src):
        """A file name, or the SVG itself as bytes."""
        import base64
        if isinstance(src, (bytes, bytearray)):
            self._img.src = "data:image/svg+xml;base64," + base64.b64encode(bytes(src)).decode("ascii")
        elif os.path.exists(str(src)):
            self._img.src = wx._data_url(str(src))

    def renderer(self):
        from .QtSvg import QSvgRenderer
        return QSvgRenderer()


class QGraphicsSvgItem:
    def __init__(self, *a):
        pass

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None
