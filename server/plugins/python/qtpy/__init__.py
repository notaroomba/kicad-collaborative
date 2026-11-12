"""qtpy for the web editor: the layer plugins use to write Qt code once for PyQt and PySide.  Here it always resolves to
the editor's PySide6 stand-in (Qt widgets drawn as page elements)."""
import PySide6 as _qt

__version__ = "2.4.3"
API_NAME = "PySide6"
API = "pyside6"
PYQT5 = PYQT6 = PYSIDE2 = False
PYSIDE6 = True
QT5 = False
QT6 = True
QT_VERSION = getattr(_qt, "__version__", "6.8.0")
PYSIDE_VERSION = QT_VERSION
PYQT_VERSION = None


class PythonQtError(RuntimeError):
    pass


class QtBindingsNotFoundError(PythonQtError, ImportError):
    pass
