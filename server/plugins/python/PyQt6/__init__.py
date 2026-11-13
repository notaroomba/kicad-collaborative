"""PyQt6 for the web editor: the same Qt interface as the PySide6 package here, under PyQt's names.

PyQt and PySide wrap the same Qt classes; what differs for a plugin is the spelling of signals, slots and properties
(pyqtSignal, pyqtSlot, pyqtProperty) and a few version constants.  Everything else is the PySide6 package.
"""

from . import QtCore, QtGui, QtWidgets          # noqa: F401
