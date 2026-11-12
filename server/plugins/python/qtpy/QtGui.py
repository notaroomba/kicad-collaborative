from PySide6.QtGui import *  # noqa: F401,F403
from PySide6 import QtGui as _m


def __getattr__(name):
    return getattr(_m, name)
