"""PySide6.QtSvg for the web editor."""

from .QtCore import QObject, QSize, QRectF


class QSvgRenderer(QObject):
    def __init__(self, *a):
        QObject.__init__(self)

    def load(self, *a):
        return True

    isValid = lambda self: True
    defaultSize = lambda self: QSize(100, 100)
    viewBoxF = viewBox = lambda self: QRectF(0, 0, 100, 100)
    render = setAspectRatioMode = setViewBox = lambda self, *a: None


class QSvgGenerator:
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None
