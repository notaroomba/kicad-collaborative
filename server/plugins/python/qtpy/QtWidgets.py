from PySide6.QtWidgets import *  # noqa: F401,F403
from PySide6 import QtWidgets as _m


def __getattr__(name):
    return getattr(_m, name)
