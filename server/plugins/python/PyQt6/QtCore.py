from PySide6.QtCore import *                    # noqa: F401,F403
from PySide6 import QtCore as _qc

pyqtSignal = _qc.Signal
pyqtBoundSignal = getattr(_qc, "SignalInstance", _qc.Signal)
pyqtSlot = _qc.Slot
pyqtProperty = getattr(_qc, "Property", property)
QT_VERSION_STR = getattr(_qc, "__version__", "6.10.2")
PYQT_VERSION_STR = "6.10.0"
QT_VERSION = 0x060A02
PYQT_VERSION = 0x060A00


def __getattr__(name):
    return getattr(_qc, name)
