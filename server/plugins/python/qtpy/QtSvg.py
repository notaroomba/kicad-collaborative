from PySide6.QtSvg import *  # noqa: F401,F403
from PySide6 import QtSvg as _m


def __getattr__(name):
    return getattr(_m, name)
