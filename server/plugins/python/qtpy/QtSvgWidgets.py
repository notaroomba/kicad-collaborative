from PySide6.QtSvgWidgets import *  # noqa: F401,F403
from PySide6 import QtSvgWidgets as _m


def __getattr__(name):
    return getattr(_m, name)
