"""PySide6 for the web editor.

Plugins for KiCad's IPC interface are programs of their own, and some draw their windows with Qt
instead of wxPython.  Qt itself is native code that cannot run in a browser, so this package gives
those plugins Qt's Python interface on top of the same HTML widgets the `wx` module here uses: a
QMainWindow is a KiCad dialog in the editor, a QPushButton is a button in it, signals and slots work
as they do in Qt.

It covers the widgets, layouts, models and helpers that plugins in KiCad's repository use.  Custom
painting (QPainter) is accepted and draws nothing.
"""

__version__ = "6.10.2"
__version_info__ = (6, 10, 2, "", "")

from . import QtCore, QtGui, QtWidgets          # noqa: E402,F401
