"""PySide6.QtWidgets for the web editor.

Every Qt widget here owns one widget of this editor's `wx` module (`self._w`), which is HTML inside
the plugin's frame; layouts own a wx sizer.  A window (QMainWindow, QDialog, or any widget shown
without a parent) is floated by the editor as a KiCad dialog.
"""

import enum
import os
import sys

import wx

from . import QtCore, QtGui
from .QtCore import QObject, Signal, SignalInstance, Qt, QSize, QPoint, QRect, QModelIndex, QItemSelectionModel, QCoreApplication, QEvent, QTimer
from .QtGui import QIcon, QPixmap, QFont, QColor, QPalette, QAction, QActionGroup, QGuiApplication, QCloseEvent, QShowEvent, QHideEvent, QFontMetrics, QShortcut  # noqa: F401

_H, _V = 1, 2


def _wx_reparent(w, parent):
    """Move a wx widget under another parent in the widget tree; where it is drawn is decided by its sizer."""
    old = getattr(w, "_wx_parent", None)
    if old is parent:
        return
    if old is not None and w in old._wx_children:
        old._wx_children.remove(w)
    w._wx_parent = parent
    if parent is not None:
        parent._wx_children.append(w)


def _text_of(s):
    return "" if s is None else str(s)


def _plain(html):
    """The text of a piece of Qt rich text."""
    import re
    s = re.sub(r"<br\s*/?>|</p>|</div>|</li>|</h\d>", "\n", str(html), flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return s.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").replace("&quot;", '"')


def _rich(s):
    import re
    return bool(re.search(r"</?(b|i|u|br|p|a|span|font|html|body|h\d|ul|li|code|pre|small|strong|em|table|tr|td|img|div|center)\b[^>]*>", str(s), re.I))


def _css_from_qss(el, qss):
    """The plain declarations of a style sheet (`color: red; font-weight: bold`) apply to the widget; selectors are skipped."""
    text = str(qss or "")
    if "{" in text:
        import re
        m = re.match(r"^\s*(?:[A-Za-z#.\w]+)?\s*\{([^{}]*)\}\s*$", text)
        if not m:
            return
        text = m.group(1)
    for part in text.split(";"):
        name, colon, value = part.partition(":")
        name, value = name.strip().lower(), value.strip()
        if not colon or not name or not value or name.startswith("qproperty"):
            continue
        if name in ("color", "background-color", "background", "font-weight", "font-style", "font-size", "font-family", "text-decoration", "padding",
                    "margin", "border", "border-radius", "min-width", "max-width", "min-height", "max-height", "text-align", "opacity",
                    "border-top", "border-bottom", "border-left", "border-right", "padding-left", "padding-right", "padding-top", "padding-bottom"):
            if "palette(" in value or "qlineargradient" in value:
                continue
            parts = name.split("-")
            prop = parts[0] + "".join(p.title() for p in parts[1:])
            try:
                setattr(el.style, prop, value)
            except Exception:
                pass


class QSizePolicy:
    class Policy(enum.IntEnum):
        Fixed = 0
        Minimum = 1
        Maximum = 4
        Preferred = 5
        MinimumExpanding = 3
        Expanding = 7
        Ignored = 13

    class ControlType(enum.IntEnum):
        DefaultType = 1

    Fixed, Minimum, Maximum, Preferred, MinimumExpanding, Expanding, Ignored = (Policy.Fixed, Policy.Minimum, Policy.Maximum, Policy.Preferred,
                                                                              Policy.MinimumExpanding, Policy.Expanding, Policy.Ignored)

    def __init__(self, h=Policy.Preferred, v=Policy.Preferred, *a):
        self._h, self._v = h, v
        self._hs = self._vs = 0

    horizontalPolicy = lambda self: self._h
    verticalPolicy = lambda self: self._v

    def setHorizontalPolicy(self, p):
        self._h = p

    def setVerticalPolicy(self, p):
        self._v = p

    def setHorizontalStretch(self, n):
        self._hs = n

    def setVerticalStretch(self, n):
        self._vs = n

    horizontalStretch = lambda self: self._hs
    verticalStretch = lambda self: self._vs
    setHeightForWidth = setWidthForHeight = setRetainSizeWhenHidden = setControlType = lambda self, *a: None
    hasHeightForWidth = hasWidthForHeight = retainSizeWhenHidden = lambda self: False


def _grows(policy):
    return int(policy) in (int(QSizePolicy.Policy.Expanding), int(QSizePolicy.Policy.MinimumExpanding))


# ----------------------------------------------------------------------------- QWidget

class QWidget(QObject):
    customContextMenuRequested = Signal(object)
    windowTitleChanged = Signal(str)

    _EXPAND = 0                # which way this kind of widget takes spare room in a layout
    _TOP = False               # a window of its own

    def __init__(self, parent=None, f=None, *a, **k):
        parent = parent if isinstance(parent, QWidget) else None
        QObject.__init__(self, parent)
        self._q_layout = None
        self._q_title = ""
        self._q_frame = None           # the window around a widget that is shown without a parent
        self._q_policy = None
        self._q_visible = None
        self._q_attrs = set()
        self._q_actions = []
        self._w = self._make(parent._host() if parent is not None else None)
        self._w._q_owner = self
        if self._TOP:
            self._w.Bind(wx.EVT_CLOSE, self._wx_close)

    # -- the wx side

    def _make(self, wxparent):
        return wx.Panel(wxparent)

    def _host(self):
        """The wx window that children of this widget are created in."""
        return self._w

    def _window_w(self):
        return self._w if self._TOP else self._q_frame

    def isWidgetType(self):
        return True

    def isWindow(self):
        return self._TOP or self._q_frame is not None

    def window(self):
        w = self
        while not w.isWindow() and isinstance(w._q_parent, QWidget):
            w = w._q_parent
        return w

    def parentWidget(self):
        return self._q_parent if isinstance(self._q_parent, QWidget) else None

    def setParent(self, parent, *a):
        QObject.setParent(self, parent)
        _wx_reparent(self._w, parent._host() if isinstance(parent, QWidget) else None)
        if parent is None:
            self._detach()

    def _detach(self):
        try:
            p = self._w.el.parentNode
            if p is not None:
                p.removeChild(self._w.el)
        except Exception:
            pass

    def deleteLater(self):
        QObject.deleteLater(self)
        _wx_reparent(self._w, None)
        self._detach()
        if self.isWindow():
            self.hide()

    # -- layout

    def layout(self):
        return self._q_layout

    def setLayout(self, layout):
        if layout is None or layout is self._q_layout:
            return
        self._q_layout = layout
        layout._attach(self)

    def _set_sizer(self, sizer):
        self._host().SetSizer(sizer)

    def updateGeometry(self):
        pass

    def adjustSize(self):
        top = self._window_w()
        if top is not None:
            top.Fit()

    # -- showing

    def _ensure_frame(self):
        if self._TOP or self._q_frame is not None:
            return
        fr = self._q_frame = wx.Frame(None, title=self._q_title or QCoreApplication.applicationName())
        fr._q_owner = self
        box = wx.BoxSizer(wx.VERTICAL)
        _wx_reparent(self._w, fr)
        box.Add(self._w, 1, wx.EXPAND)
        fr.SetSizer(box)
        want = getattr(self, "_q_size", None)
        if want:
            fr.SetSize(want)
        fr.Bind(wx.EVT_CLOSE, self._wx_close)

    def show(self):
        if self._q_parent is None or self._TOP:
            self._ensure_frame()
            top = self._window_w()
            was = getattr(top, "_wx_visible", False)
            top.Show(True)
            if not was:
                wx._call(self.showEvent, QShowEvent())
        else:
            self._q_visible = True
            self._w.Show(True)

    def hide(self):
        top = self._window_w()
        if top is not None:
            if getattr(top, "_wx_visible", False):
                top.Show(False)
                wx._call(self.hideEvent, QHideEvent())
        else:
            self._q_visible = False
            self._w.Show(False)

    def setVisible(self, on):
        self.show() if on else self.hide()

    def setHidden(self, off):
        self.setVisible(not off)

    def isVisible(self):
        top = self._window_w()
        if top is not None:
            return bool(getattr(top, "_wx_visible", False))
        if self._q_visible is False:
            return False
        p = self.parentWidget()
        return p.isVisible() if p is not None else False

    def isHidden(self):
        return self._q_visible is False if not self.isWindow() else not self.isVisible()

    isVisibleTo = lambda self, other: self._q_visible is not False

    def close(self):
        ev = QCloseEvent()
        wx._call(self.closeEvent, ev)
        if not ev.isAccepted():
            return False
        self._closed()
        return True

    def _closed(self):
        self.hide()

    def _wx_close(self, event=None):
        """The person closed the window with its close button."""
        self.close()

    def raise_(self):
        top = self._window_w()
        if top is not None:
            top.Raise()

    activateWindow = showNormal = showMaximized = showFullScreen = lambda self: self.show() if self.isWindow() or self._q_parent is None else None
    showMinimized = lambda self: None
    isActiveWindow = lambda self: self.isVisible()
    isMaximized = isMinimized = isFullScreen = isModal = lambda self: False
    lower = stackUnder = repaint = unsetCursor = clearFocus = ensurePolished = clearMask = lambda self, *a: None

    def update(self, *a):
        pass

    # -- events a subclass may override

    def closeEvent(self, e):
        e.accept()

    def showEvent(self, e):
        pass

    def hideEvent(self, e):
        pass

    def resizeEvent(self, e):
        pass

    def paintEvent(self, e):
        pass

    keyPressEvent = keyReleaseEvent = mousePressEvent = mouseReleaseEvent = mouseMoveEvent = mouseDoubleClickEvent = wheelEvent = \
        enterEvent = leaveEvent = focusInEvent = focusOutEvent = changeEvent = moveEvent = contextMenuEvent = \
        dragEnterEvent = dragMoveEvent = dropEvent = lambda self, e: None

    # -- titles, enabling, tips

    def setWindowTitle(self, t):
        self._q_title = _text_of(t)
        top = self._window_w()
        if top is not None:
            top.SetTitle(self._q_title)
        self.windowTitleChanged.emit(self._q_title)

    def windowTitle(self):
        return self._q_title

    setWindowIcon = setWindowFlags = setWindowFlag = setWindowModality = setWindowState = setWindowOpacity = setWindowIconText = \
        setWindowFilePath = setWindowModified = setWindowRole = lambda self, *a: None
    windowFlags = lambda self: Qt.WindowType.Window if self.isWindow() else Qt.WindowType.Widget
    windowIcon = lambda self: QIcon()
    windowState = lambda self: Qt.WindowState.WindowNoState

    def setEnabled(self, on):
        self._w.Enable(bool(on))

    def setDisabled(self, off):
        self._w.Enable(not off)

    def isEnabled(self):
        return bool(self._w.IsEnabled())

    isEnabledTo = lambda self, other: self.isEnabled()

    def setToolTip(self, tip):
        self._q_tip = _plain(tip) if _rich(tip) else _text_of(tip)
        self._w.SetToolTip(self._q_tip)

    def toolTip(self):
        return getattr(self, "_q_tip", "")

    setStatusTip = setWhatsThis = setAccessibleName = setAccessibleDescription = setToolTipDuration = lambda self, *a: None
    statusTip = whatsThis = accessibleName = lambda self: ""

    def setFocus(self, *a):
        self._w.SetFocus()

    hasFocus = lambda self: False
    setFocusPolicy = setFocusProxy = setTabOrder = setContextMenuPolicy = setAcceptDrops = setMouseTracking = setAutoFillBackground = \
        setLayoutDirection = setLocale = setInputMethodHints = setGraphicsEffect = setBackgroundRole = setForegroundRole = setTabletTracking = \
        setUpdatesEnabled = setCursor = setMask = setStyle = setContentsMargins = setShortcutEnabled = grabKeyboard = releaseKeyboard = \
        grabMouse = releaseMouse = setSizeIncrement = setBaseSize = lambda self, *a, **k: None
    focusPolicy = lambda self: Qt.FocusPolicy.StrongFocus
    contextMenuPolicy = lambda self: Qt.ContextMenuPolicy.DefaultContextMenu
    hasMouseTracking = acceptDrops = underMouse = lambda self: False
    updatesEnabled = lambda self: True
    focusWidget = lambda self: None

    def setAttribute(self, attr, on=True):
        (self._q_attrs.add if on else self._q_attrs.discard)(int(attr))

    def testAttribute(self, attr):
        return int(attr) in self._q_attrs

    # -- look

    def setStyleSheet(self, qss):
        self._q_qss = _text_of(qss)
        _css_from_qss(self._w.el, qss)

    styleSheet = lambda self: getattr(self, "_q_qss", "")

    def style(self):
        return QApplication.style()

    def setFont(self, font):
        self._q_font = font
        if isinstance(font, QFont):
            font._apply(self._w.el.style)

    def font(self):
        return getattr(self, "_q_font", None) or QFont()

    def fontMetrics(self):
        return QFontMetrics(self.font())

    fontInfo = lambda self: QtGui.QFontInfo(self.font())

    def palette(self):
        if getattr(self, "_q_palette", None) is None:
            self._q_palette = QPalette()
        return self._q_palette

    def setPalette(self, p):
        self._q_palette = p

    def setObjectName(self, name):
        QObject.setObjectName(self, name)
        try:
            self._w.SetName(str(name))
        except Exception:
            pass

    # -- size

    def _px(self, v):
        return f"{int(v)}px"

    def resize(self, *a):
        w, h = (a[0].width(), a[0].height()) if len(a) == 1 else a[:2]
        self._q_size = (int(w), int(h))
        top = self._window_w()
        if top is not None:
            top.SetSize((int(w), int(h)))

    def setGeometry(self, *a):
        r = a[0] if len(a) == 1 else QRect(*a)
        if self.isWindow() or self._q_parent is None:
            self.resize(r.width(), r.height())

    def move(self, *a):
        pass

    def setMinimumSize(self, *a):
        w, h = (a[0].width(), a[0].height()) if len(a) == 1 else a[:2]
        self.setMinimumWidth(w)
        self.setMinimumHeight(h)

    def setMaximumSize(self, *a):
        w, h = (a[0].width(), a[0].height()) if len(a) == 1 else a[:2]
        self.setMaximumWidth(w)
        self.setMaximumHeight(h)

    def setFixedSize(self, *a):
        w, h = (a[0].width(), a[0].height()) if len(a) == 1 else a[:2]
        self.setFixedWidth(w)
        self.setFixedHeight(h)

    def setMinimumWidth(self, w):
        if 0 < w < 16777215:
            self._w.el.style.minWidth = self._px(w)

    def setMinimumHeight(self, h):
        if 0 < h < 16777215:
            self._w.el.style.minHeight = self._px(h)

    def setMaximumWidth(self, w):
        if 0 < w < 16777215:
            self._w.el.style.maxWidth = self._px(w)

    def setMaximumHeight(self, h):
        if 0 < h < 16777215:
            self._w.el.style.maxHeight = self._px(h)

    def setFixedWidth(self, w):
        self._w.el.style.width = self._w.el.style.minWidth = self._w.el.style.maxWidth = self._px(w)
        self._w.el.style.flex = self._w.el.style.flex or ""

    def setFixedHeight(self, h):
        self._w.el.style.height = self._w.el.style.minHeight = self._w.el.style.maxHeight = self._px(h)

    def _dim(self, name, fallback):
        try:
            v = getattr(self._w.el, name)
            return int(v) if v else fallback
        except Exception:
            return fallback

    def width(self):
        s = getattr(self, "_q_size", None)
        return self._dim("offsetWidth", s[0] if s else 100)

    def height(self):
        s = getattr(self, "_q_size", None)
        return self._dim("offsetHeight", s[1] if s else 30)

    def size(self):
        return QSize(self.width(), self.height())

    def rect(self):
        return QRect(0, 0, self.width(), self.height())

    geometry = frameGeometry = contentsRect = childrenRect = normalGeometry = rect
    sizeHint = minimumSizeHint = minimumSize = baseSize = lambda self: QSize(self.width(), self.height())
    maximumSize = lambda self: QSize(16777215, 16777215)
    minimumWidth = minimumHeight = lambda self: 0
    maximumWidth = maximumHeight = lambda self: 16777215
    x = y = lambda self: 0
    pos = lambda self: QPoint(0, 0)
    mapToGlobal = mapFromGlobal = mapTo = mapFrom = mapToParent = mapFromParent = lambda self, p, *a: p
    devicePixelRatio = devicePixelRatioF = lambda self: 1.0
    logicalDpiX = logicalDpiY = physicalDpiX = physicalDpiY = lambda self: 96
    screen = lambda self: QtGui.QScreen()
    winId = effectiveWinId = lambda self: 0
    windowHandle = lambda self: None
    contentsMargins = lambda self: QtCore.QMargins()
    grab = lambda self, *a: QPixmap()
    cursor = lambda self: QtGui.QCursor()
    childAt = lambda self, *a: None

    def sizePolicy(self):
        if self._q_policy is None:
            self._q_policy = QSizePolicy(QSizePolicy.Policy.Expanding if self._EXPAND & _H else QSizePolicy.Policy.Preferred,
                                         QSizePolicy.Policy.Expanding if self._EXPAND & _V else QSizePolicy.Policy.Preferred)
        return self._q_policy

    def setSizePolicy(self, *a):
        self._q_policy = a[0] if len(a) == 1 and isinstance(a[0], QSizePolicy) else QSizePolicy(*a[:2])

    def _expands(self):
        if self._q_policy is not None:
            return (_H if _grows(self._q_policy._h) else 0) | (_V if _grows(self._q_policy._v) else 0)
        e = self._EXPAND
        if self._q_layout is not None:
            e |= self._q_layout._expands()
        return e

    # -- actions

    def addAction(self, *a):
        act = a[0] if a and isinstance(a[0], QAction) else QAction(*a, self)
        if not isinstance(a[0], QAction):
            fn = next((x for x in a if callable(x) and not isinstance(x, QObject)), None)
            if fn is not None:
                act.triggered.connect(fn)
        self._q_actions.append(act)
        self._action_added(act)
        return act

    def addActions(self, actions):
        for a in actions:
            self.addAction(a)

    def _action_added(self, act):
        pass

    def removeAction(self, act):
        if act in self._q_actions:
            self._q_actions.remove(act)

    def insertAction(self, before, act):
        self.addAction(act)

    def actions(self):
        return list(self._q_actions)

    @staticmethod
    def setTabOrder(*a):
        pass

    @staticmethod
    def find(*a):
        return None

    @staticmethod
    def createWindowContainer(*a, **k):
        return QWidget()


# ----------------------------------------------------------------------------- layouts

class QLayoutItem:
    def __init__(self, widget=None, layout=None, spacer=None):
        self._widget, self._layout, self._spacer = widget, layout, spacer

    widget = lambda self: self._widget
    layout = lambda self: self._layout
    spacerItem = lambda self: self._spacer
    isEmpty = lambda self: self._widget is None and self._layout is None
    geometry = lambda self: QRect(0, 0, 0, 0)
    sizeHint = minimumSize = lambda self: QSize(0, 0)
    setAlignment = setGeometry = invalidate = lambda self, *a: None
    alignment = lambda self: Qt.AlignmentFlag(0)


class QSpacerItem(QLayoutItem):
    def __init__(self, w=0, h=0, hpolicy=QSizePolicy.Policy.Minimum, vpolicy=QSizePolicy.Policy.Minimum):
        QLayoutItem.__init__(self, spacer=self)
        self._sw, self._sh, self._hp, self._vp = w, h, hpolicy, vpolicy

    def changeSize(self, w, h, hpolicy=QSizePolicy.Policy.Minimum, vpolicy=QSizePolicy.Policy.Minimum):
        self._sw, self._sh, self._hp, self._vp = w, h, hpolicy, vpolicy

    spacerItem = lambda self: self


def _align_flags(alignment, vertical_box=None):
    """wx sizer flags for a Qt alignment; with none given a widget fills the space across its layout."""
    a = int(alignment or 0)
    if not a:
        return wx.EXPAND
    flag = 0
    if a & 0x2:
        flag |= wx.ALIGN_RIGHT
    elif a & 0x4:
        flag |= wx.ALIGN_CENTER_HORIZONTAL
    if a & 0x40:
        flag |= wx.ALIGN_BOTTOM
    elif a & 0x80:
        flag |= wx.ALIGN_CENTER_VERTICAL
    # an alignment along one axis only leaves the other axis filling
    if vertical_box is True and not (a & 0x1f):
        flag |= wx.EXPAND
    if vertical_box is False and not (a & 0x1e0):
        flag |= wx.EXPAND
    return flag


class QLayout(QObject):
    class SizeConstraint(enum.IntEnum):
        SetDefaultConstraint = 0
        SetNoConstraint = 1
        SetMinimumSize = 2
        SetFixedSize = 3
        SetMaximumSize = 4
        SetMinAndMaxSize = 5

    SetDefaultConstraint, SetNoConstraint, SetMinimumSize, SetFixedSize, SetMaximumSize, SetMinAndMaxSize = (
        SizeConstraint.SetDefaultConstraint, SizeConstraint.SetNoConstraint, SizeConstraint.SetMinimumSize, SizeConstraint.SetFixedSize,
        SizeConstraint.SetMaximumSize, SizeConstraint.SetMinAndMaxSize)

    def __init__(self, parent=None):
        QObject.__init__(self, None)
        self._s = self._make_sizer()
        self._items = []
        self._owner = None
        self._outer = None
        self._margins = None
        self._s.el.style.gap = "6px"
        if isinstance(parent, QWidget):
            parent.setLayout(self)

    def _make_sizer(self):
        return wx.BoxSizer(wx.VERTICAL)

    # the widget this layout (or the layout it sits in) arranges
    def _attach(self, widget):
        self._owner = widget
        if self._margins is None:
            self._s.el.style.padding = "0" if isinstance(widget, (QMainWindow,)) else "9px"
        widget._set_sizer(self._s)
        self._adopt_all(widget)

    def _adopt_all(self, widget):
        self._owner = widget
        for it in self._items:
            if it._widget is not None:
                self._adopt(it._widget)
            elif it._layout is not None:
                it._layout._adopt_all(widget)

    def _adopt(self, w):
        owner = self._owner
        if owner is None:
            return
        if w._q_parent is not owner:
            QObject.setParent(w, owner)
        _wx_reparent(w._w, owner._host())
        if isinstance(w, QRadioButton):
            w._join(owner._host())

    def parentWidget(self):
        return self._owner

    def _record(self, item, index=None):
        if index is None or index < 0 or index >= len(self._items):
            self._items.append(item)
        else:
            self._items.insert(index, item)
        return item

    def _expands(self):
        e = 0
        for it in self._items:
            if it._widget is not None:
                e |= it._widget._expands()
            elif it._layout is not None:
                e |= it._layout._expands()
            elif it._spacer is not None:
                e |= (_H if _grows(it._spacer._hp) else 0) | (_V if _grows(it._spacer._vp) else 0)
        return e

    def count(self):
        return len(self._items)

    def itemAt(self, i):
        return self._items[i] if 0 <= i < len(self._items) else None

    def indexOf(self, thing):
        for i, it in enumerate(self._items):
            if it._widget is thing or it._layout is thing or it is thing:
                return i
        return -1

    def takeAt(self, i):
        if not 0 <= i < len(self._items):
            return None
        it = self._items.pop(i)
        thing = it._widget._w if it._widget is not None else (it._layout._s if it._layout is not None else getattr(it, "_wx_item", None))
        if thing is not None:
            try:
                self._s.Detach(thing)
            except Exception:
                pass
        if it._widget is not None:
            it._widget._detach()
        return it

    def removeWidget(self, w):
        i = self.indexOf(w)
        if i >= 0:
            self.takeAt(i)

    def removeItem(self, item):
        i = self.indexOf(item)
        if i >= 0:
            self.takeAt(i)

    def replaceWidget(self, old, new, *a):
        i = self.indexOf(old)
        if i < 0:
            return None
        it = self.takeAt(i)
        self.insertWidget(i, new) if hasattr(self, "insertWidget") else self.addWidget(new)
        return it

    def setContentsMargins(self, *a):
        m = a if len(a) == 4 else ((a[0].left(), a[0].top(), a[0].right(), a[0].bottom()) if a else (0, 0, 0, 0))
        self._margins = tuple(int(v) for v in m)
        self._s.el.style.padding = "%dpx %dpx %dpx %dpx" % (self._margins[1], self._margins[2], self._margins[3], self._margins[0])

    def contentsMargins(self):
        m = self._margins or (9, 9, 9, 9)
        return QtCore.QMargins(*m)

    def getContentsMargins(self):
        return self._margins or (9, 9, 9, 9)

    def setSpacing(self, px):
        self._spacing = int(px)
        self._s.el.style.gap = f"{int(px)}px"

    def spacing(self):
        return getattr(self, "_spacing", 6)

    def setAlignment(self, *a):
        al = int(a[-1]) if a else 0
        if len(a) == 1:
            st = self._s.el.style
            if al & 0x20:
                st.alignContent = "start"
            if al & 0x4 or al == 0x84:
                st.justifyContent = "center"
        return True

    setSizeConstraint = setMenuBar = invalidate = activate = update = setEnabled = setGeometry = lambda self, *a: None
    sizeHint = minimumSize = lambda self: QSize(0, 0)
    geometry = contentsRect = lambda self: QRect(0, 0, 0, 0)
    isEmpty = lambda self: not self._items
    layout = lambda self: self
    widget = lambda self: None

    def addItem(self, item):
        if isinstance(item, QSpacerItem):
            self._add_spacer(item)
        elif isinstance(item, QLayout):
            self.addLayout(item)

    def _add_spacer(self, item):
        self._record(item)


class QBoxLayout(QLayout):
    class Direction(enum.IntEnum):
        LeftToRight = 0
        RightToLeft = 1
        TopToBottom = 2
        BottomToTop = 3

    LeftToRight, RightToLeft, TopToBottom, BottomToTop = Direction.LeftToRight, Direction.RightToLeft, Direction.TopToBottom, Direction.BottomToTop
    _VERT = True

    def __init__(self, *a):
        direction = next((x for x in a if isinstance(x, QBoxLayout.Direction)), None)
        if direction is not None:
            self._VERT = int(direction) >= 2
        QLayout.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))

    def _make_sizer(self):
        return wx.BoxSizer(wx.VERTICAL if self._VERT else wx.HORIZONTAL)

    def _along(self):
        return _V if self._VERT else _H

    def _prop(self, thing, stretch):
        if stretch:
            return int(stretch)
        return 1 if thing._expands() & self._along() else 0

    def _put(self, index, thing, prop, flag):
        if index is None or index < 0 or index >= len(self._items):
            return self._s.Add(thing, prop, flag, 0)
        return self._s.Insert(index, thing, prop, flag, 0)

    def addWidget(self, w, stretch=0, alignment=0):
        self.insertWidget(-1, w, stretch, alignment)

    def insertWidget(self, index, w, stretch=0, alignment=0):
        self._adopt(w)
        pol = w._q_policy
        if not stretch and pol is not None:
            stretch = pol._vs if self._VERT else pol._hs
        self._put(index, w._w, self._prop(w, stretch), _align_flags(alignment, self._VERT))
        self._record(QLayoutItem(widget=w), index)
        if w._q_visible is None and not w._TOP:
            w._q_visible = True

    def addLayout(self, layout, stretch=0):
        self.insertLayout(-1, layout, stretch)

    def insertLayout(self, index, layout, stretch=0):
        layout._outer = self
        if self._owner is not None:
            layout._adopt_all(self._owner)
        if layout._margins is None:
            layout._s.el.style.padding = "0"
        self._put(index, layout._s, self._prop(layout, stretch), wx.EXPAND)
        self._record(QLayoutItem(layout=layout), index)

    def addStretch(self, stretch=0):
        self.insertStretch(-1, stretch)

    def insertStretch(self, index, stretch=0):
        item = QSpacerItem(0, 0, QSizePolicy.Policy.Expanding if not self._VERT else QSizePolicy.Policy.Minimum,
                           QSizePolicy.Policy.Expanding if self._VERT else QSizePolicy.Policy.Minimum)
        el = wx.Panel(None)
        item._wx_item = el
        self._put(index, el, max(1, int(stretch or 1)), 0)
        self._record(item, index)

    def addSpacing(self, px):
        self.insertSpacing(-1, px)

    def insertSpacing(self, index, px):
        item = QSpacerItem(px, px)
        el = wx.Panel(None)
        el.el.style.width = el.el.style.height = f"{int(px)}px"
        el.el.style.flex = "0 0 auto"
        item._wx_item = el
        self._put(index, el, 0, 0)
        self._record(item, index)

    def addSpacerItem(self, item):
        self._add_spacer(item)

    insertSpacerItem = lambda self, index, item: self._add_spacer(item)
    insertItem = lambda self, index, item: self.addItem(item)

    def _add_spacer(self, item):
        grow = _grows(item._vp if self._VERT else item._hp)
        el = wx.Panel(None)
        item._wx_item = el
        if not grow:
            px = item._sh if self._VERT else item._sw
            setattr(el.el.style, "height" if self._VERT else "width", f"{int(px)}px")
        self._s.Add(el, 1 if grow else 0, 0, 0)
        self._record(item)

    def setStretch(self, index, stretch):
        it = self.itemAt(index)
        if it is None:
            return
        thing = it._widget._w if it._widget is not None else (it._layout._s if it._layout is not None else getattr(it, "_wx_item", None))
        el = getattr(thing, "el", None)
        try:
            holder = el.parentNode if (it._widget is not None and el is not None and el.parentNode is not self._s.el) else el
            if holder is not None and stretch:
                holder.style.flex = f"{int(stretch)} 1 0%"
        except Exception:
            pass

    def setStretchFactor(self, thing, stretch):
        i = self.indexOf(thing)
        if i >= 0:
            self.setStretch(i, stretch)
        return i >= 0

    stretch = lambda self, i: 0
    setDirection = lambda self, d: None
    direction = lambda self: QBoxLayout.Direction.TopToBottom if self._VERT else QBoxLayout.Direction.LeftToRight


class QVBoxLayout(QBoxLayout):
    _VERT = True


class QHBoxLayout(QBoxLayout):
    _VERT = False


class QGridLayout(QLayout):
    def _make_sizer(self):
        return wx.GridBagSizer(6, 6)

    def _grow(self, thing, row, col, rs, cs):
        e = thing._expands()
        if e & _H and cs == 1:
            self._col_stretch(col, 1)
        if e & _V and rs == 1:
            self._row_stretch(row, 1)

    def _fit(self):
        """A column that takes spare room may also give room up: what is in it scrolls or wraps instead of widening the window."""
        st = self._s.el.style
        try:
            cols = str(st.gridTemplateColumns or "")
            if "minmax(max-content" in cols:
                st.gridTemplateColumns = cols.replace("minmax(max-content", "minmax(0px")
        except Exception:
            pass

    def _col_stretch(self, col, n):
        try:
            if n and not self._s.IsColGrowable(col):
                self._s.AddGrowableCol(col, int(n))
        except Exception:
            pass
        self._fit()

    def _row_stretch(self, row, n):
        try:
            if n and not self._s.IsRowGrowable(row):
                self._s.AddGrowableRow(row, int(n))
        except Exception:
            pass

    def addWidget(self, w, row=None, col=0, rowspan=1, colspan=1, alignment=0):
        if row is None:
            row = self.rowCount()
        if isinstance(rowspan, enum.Enum) and not isinstance(rowspan, int):
            rowspan, alignment = 1, rowspan
        elif isinstance(rowspan, Qt.AlignmentFlag):
            rowspan, alignment = 1, rowspan
        rowspan, colspan = (rowspan if rowspan > 0 else 1), (colspan if colspan > 0 else 1)
        self._adopt(w)
        self._s.Add(w._w, (row, col), (rowspan, colspan), _align_flags(alignment))
        it = self._record(QLayoutItem(widget=w))
        it._cell = (row, col, rowspan, colspan)
        self._grow(w, row, col, rowspan, colspan)
        self._fit()
        if w._q_visible is None and not w._TOP:
            w._q_visible = True

    def addLayout(self, layout, row=0, col=0, rowspan=1, colspan=1, alignment=0):
        if isinstance(rowspan, Qt.AlignmentFlag):
            rowspan = 1
        layout._outer = self
        if self._owner is not None:
            layout._adopt_all(self._owner)
        if layout._margins is None:
            layout._s.el.style.padding = "0"
        self._s.Add(layout._s, (row, col), (max(1, rowspan), max(1, colspan)), wx.EXPAND)
        it = self._record(QLayoutItem(layout=layout))
        it._cell = (row, col, max(1, rowspan), max(1, colspan))
        self._grow(layout, row, col, max(1, rowspan), max(1, colspan))
        self._fit()

    def addItem(self, item, row=0, col=0, rowspan=1, colspan=1, alignment=0):
        if isinstance(item, QLayout):
            return self.addLayout(item, row, col, rowspan, colspan)
        if isinstance(item, QSpacerItem):
            el = wx.Panel(None)
            item._wx_item = el
            self._s.Add(el, (row, col), (max(1, rowspan), max(1, colspan)), wx.EXPAND)
            it = self._record(item)
            it._cell = (row, col, max(1, rowspan), max(1, colspan))
            if _grows(item._hp):
                self._col_stretch(col, 1)
            if _grows(item._vp):
                self._row_stretch(row, 1)

    def rowCount(self):
        return max([it._cell[0] + it._cell[2] for it in self._items if hasattr(it, "_cell")] or [0])

    def columnCount(self):
        return max([it._cell[1] + it._cell[3] for it in self._items if hasattr(it, "_cell")] or [0])

    def itemAtPosition(self, row, col):
        for it in self._items:
            c = getattr(it, "_cell", None)
            if c and c[0] <= row < c[0] + c[2] and c[1] <= col < c[1] + c[3]:
                return it
        return None

    def getItemPosition(self, index):
        it = self.itemAt(index)
        return getattr(it, "_cell", (0, 0, 1, 1)) if it is not None else (-1, -1, 0, 0)

    def setColumnStretch(self, col, n):
        self._col_stretch(col, n)

    def setRowStretch(self, row, n):
        self._row_stretch(row, n)

    def setHorizontalSpacing(self, px):
        self._s.SetHGap(int(px))

    def setVerticalSpacing(self, px):
        self._s.SetVGap(int(px))

    def setSpacing(self, px):
        self._spacing = int(px)
        self._s.SetHGap(int(px))
        self._s.SetVGap(int(px))

    horizontalSpacing = verticalSpacing = lambda self: getattr(self, "_spacing", 6)
    setColumnMinimumWidth = setRowMinimumHeight = setOriginCorner = lambda self, *a: None
    columnStretch = rowStretch = lambda self, i: 0


class QFormLayout(QGridLayout):
    class ItemRole(enum.IntEnum):
        LabelRole = 0
        FieldRole = 1
        SpanningRole = 2

    class FieldGrowthPolicy(enum.IntEnum):
        FieldsStayAtSizeHint = 0
        ExpandingFieldsGrow = 1
        AllNonFixedFieldsGrow = 2

    class RowWrapPolicy(enum.IntEnum):
        DontWrapRows = 0
        WrapLongRows = 1
        WrapAllRows = 2

    LabelRole, FieldRole, SpanningRole = ItemRole.LabelRole, ItemRole.FieldRole, ItemRole.SpanningRole
    FieldsStayAtSizeHint, ExpandingFieldsGrow, AllNonFixedFieldsGrow = FieldGrowthPolicy.FieldsStayAtSizeHint, FieldGrowthPolicy.ExpandingFieldsGrow, FieldGrowthPolicy.AllNonFixedFieldsGrow
    DontWrapRows, WrapLongRows, WrapAllRows = RowWrapPolicy.DontWrapRows, RowWrapPolicy.WrapLongRows, RowWrapPolicy.WrapAllRows

    def __init__(self, parent=None):
        QGridLayout.__init__(self, parent)
        self._rows = 0
        self._col_stretch(1, 1)

    def _label(self, label):
        if isinstance(label, str):
            label = QLabel(label)
        return label

    def addRow(self, *a):
        self.insertRow(self._rows, *a)

    def insertRow(self, row, *a):
        row = self._rows
        self._rows += 1
        if len(a) == 1:
            if isinstance(a[0], QLayout):
                QGridLayout.addLayout(self, a[0], row, 0, 1, 2)
            else:
                QGridLayout.addWidget(self, a[0], row, 0, 1, 2)
            return
        label, field = self._label(a[0]), a[1]
        if label is not None:
            QGridLayout.addWidget(self, label, row, 0, 1, 1, Qt.AlignmentFlag.AlignVCenter)
        if isinstance(field, QLayout):
            QGridLayout.addLayout(self, field, row, 1)
        elif field is not None:
            QGridLayout.addWidget(self, field, row, 1)

    def setWidget(self, row, role, widget):
        self._rows = max(self._rows, row + 1)
        if int(role) == 2:
            QGridLayout.addWidget(self, widget, row, 0, 1, 2)
        else:
            QGridLayout.addWidget(self, widget, row, int(role), 1, 1, Qt.AlignmentFlag.AlignVCenter if int(role) == 0 else 0)

    def setLayout(self, row, role, layout):
        self._rows = max(self._rows, row + 1)
        QGridLayout.addLayout(self, layout, row, 0 if int(role) == 2 else int(role), 1, 2 if int(role) == 2 else 1)

    def rowCount(self):
        return self._rows

    def labelForField(self, field):
        for it in self._items:
            c = getattr(it, "_cell", None)
            if c and it._widget is field:
                lab = self.itemAtPosition(c[0], 0)
                return lab._widget if lab is not None else None
        return None

    def setRowVisible(self, row, on):
        if not isinstance(row, int):
            for it in self._items:
                if it._widget is row or it._layout is row:
                    row = it._cell[0]
                    break
            else:
                return
        for it in self._items:
            c = getattr(it, "_cell", None)
            if c and c[0] == row and it._widget is not None:
                it._widget.setVisible(on)

    def removeRow(self, row):
        for it in [i for i in self._items if getattr(i, "_cell", (None,))[0] == row]:
            self.removeItem(it)
            if it._widget is not None:
                it._widget.deleteLater()

    setLabelAlignment = setFormAlignment = setFieldGrowthPolicy = setRowWrapPolicy = lambda self, *a: None


class QStackedLayout(QLayout):
    currentChanged = Signal(int)

    def __init__(self, parent=None):
        QLayout.__init__(self, parent)
        self._index = -1

    def addWidget(self, w):
        self._adopt(w)
        self._s.Add(w._w, 1, wx.EXPAND)
        self._record(QLayoutItem(widget=w))
        if self._index < 0:
            self._index = 0
        self._sync()
        return len(self._items) - 1

    def _sync(self):
        for i, it in enumerate(self._items):
            it._widget._w.Show(i == self._index)

    def setCurrentIndex(self, i):
        if 0 <= i < len(self._items) and i != self._index:
            self._index = i
            self._sync()
            self.currentChanged.emit(i)

    def setCurrentWidget(self, w):
        self.setCurrentIndex(self.indexOf(w))

    currentIndex = lambda self: self._index
    currentWidget = lambda self: self._items[self._index]._widget if 0 <= self._index < len(self._items) else None
    widget = lambda self, i: self._items[i]._widget if 0 <= i < len(self._items) else None
    setStackingMode = lambda self, *a: None


# ----------------------------------------------------------------------------- simple controls

class QFrame(QWidget):
    class Shape(enum.IntEnum):
        NoFrame = 0
        Box = 1
        Panel = 2
        WinPanel = 3
        HLine = 4
        VLine = 5
        StyledPanel = 6

    class Shadow(enum.IntEnum):
        Plain = 16
        Raised = 32
        Sunken = 48

    NoFrame, Box, Panel, WinPanel, HLine, VLine, StyledPanel = Shape.NoFrame, Shape.Box, Shape.Panel, Shape.WinPanel, Shape.HLine, Shape.VLine, Shape.StyledPanel
    Plain, Raised, Sunken = Shadow.Plain, Shadow.Raised, Shadow.Sunken

    def setFrameShape(self, shape):
        self._shape = shape
        st = self._w.el.style
        if int(shape) == 4:
            st.borderTop = "1px solid var(--line)"
            st.height = "0"
            st.minHeight = "0"
            st.alignSelf = "stretch"
        elif int(shape) == 5:
            st.borderLeft = "1px solid var(--line)"
            st.width = "0"
            st.alignSelf = "stretch"
        elif int(shape) in (1, 2, 3, 6):
            st.border = "1px solid var(--line)"
            st.borderRadius = "3px"
        else:
            st.border = "0"

    def setFrameStyle(self, style):
        self.setFrameShape(int(style) & 0x0f)

    frameShape = lambda self: getattr(self, "_shape", QFrame.Shape.NoFrame)
    setFrameShadow = setLineWidth = setMidLineWidth = setFrameRect = lambda self, *a: None
    frameWidth = lineWidth = lambda self: 1


class QLabel(QFrame):
    linkActivated = Signal(str)
    linkHovered = Signal(str)

    def __init__(self, *a, **k):
        text = next((x for x in a if isinstance(x, str)), k.get("text", ""))
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), k.get("parent")))
        self._text = ""
        self._links = False
        if text:
            self.setText(text)

    def _make(self, wxparent):
        return wx.StaticText(wxparent, label="")

    def setText(self, text):
        self._text = _text_of(text)
        if _rich(self._text):
            try:
                self._w.el.innerHTML = self._text
                if wx._DOM:
                    for a in self._w.el.querySelectorAll("a"):
                        a.target = "_blank"
                        a.rel = "noopener"
                return
            except Exception:
                pass
        self._w.SetLabel(self._text)

    def text(self):
        return self._text

    def setNum(self, n):
        self.setText(str(n))

    def clear(self):
        self.setText("")

    def setPixmap(self, pm):
        self._pixmap = pm
        url = pm._url() if hasattr(pm, "_url") else ""
        if url:
            img = wx._el("img")
            img.src = url
            if pm._w and pm._h:
                img.style.width, img.style.height = f"{pm._w}px", f"{pm._h}px"
            self._w.el.textContent = ""
            self._w.el.appendChild(img)

    pixmap = lambda self: getattr(self, "_pixmap", QPixmap())

    def setWordWrap(self, on):
        self._w.el.style.whiteSpace = "normal" if on else ""

    def setAlignment(self, al):
        a = int(al)
        self._w.el.style.textAlign = "center" if a & 0x4 else ("right" if a & 0x2 else "")

    setOpenExternalLinks = setTextFormat = setBuddy = setIndent = setMargin = setScaledContents = setTextInteractionFlags = setMovie = setSelection = lambda self, *a: None
    wordWrap = lambda self: False
    alignment = lambda self: Qt.AlignmentFlag.AlignLeft


class QAbstractButton(QWidget):
    clicked = Signal(bool)
    toggled = Signal(bool)
    pressed = Signal()
    released = Signal()

    def __init__(self, *a, **k):
        text = next((x for x in a if isinstance(x, str)), k.get("text", ""))
        icon = next((x for x in a if isinstance(x, QIcon)), None)
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), k.get("parent")))
        self._text = ""
        self._checkable = False
        self._checked = False
        self._group = None
        self._hook()
        if text:
            self.setText(text)
        if icon is not None:
            self.setIcon(icon)

    def _hook(self):
        self._w.Bind(wx.EVT_BUTTON, self._wx_clicked)

    def _wx_clicked(self, event=None):
        if self._checkable:
            self._set_checked(not self._checked)
        self.pressed.emit()
        self.released.emit()
        self.clicked.emit(self.isChecked())

    def click(self):
        if self.isEnabled():
            self._wx_clicked()

    animateClick = click

    def setText(self, text):
        self._text = _text_of(text)
        self._w.SetLabel(self._text.replace("&&", "\0").replace("&", "").replace("\0", "&"))

    def text(self):
        return self._text

    def setIcon(self, icon):
        self._icon = icon
        url = icon._url() if hasattr(icon, "_url") else ""
        if url and hasattr(self._w, "SetBitmap"):
            try:
                self._w.SetBitmap(wx.Bitmap(icon._path))
            except Exception:
                pass

    icon = lambda self: getattr(self, "_icon", QIcon())

    def setCheckable(self, on):
        self._checkable = bool(on)

    def isCheckable(self):
        return self._checkable

    def isChecked(self):
        return self._checked

    def _show_checked(self):
        try:
            self._w.el.classList.toggle("active", self._checked)
        except Exception:
            pass

    def _set_checked(self, on):
        on = bool(on)
        if on == self._checked:
            return
        self._checked = on
        self._show_checked()
        if on and self._group is not None:
            self._group._exclusive(self)
        self.toggled.emit(on)

    def setChecked(self, on):
        if self._checkable or isinstance(self, (QCheckBox, QRadioButton)):
            self._set_checked(on)

    def toggle(self):
        self.setChecked(not self.isChecked())

    def group(self):
        return self._group

    setIconSize = setShortcut = setAutoRepeat = setAutoExclusive = setAutoRepeatDelay = setAutoRepeatInterval = setDown = lambda self, *a: None
    iconSize = lambda self: QSize(16, 16)
    isDown = lambda self: False


class QPushButton(QAbstractButton):
    def _make(self, wxparent):
        return wx.Button(wxparent, label="")

    def setDefault(self, on):
        if on:
            try:
                self._w.SetDefault()
            except Exception:
                pass

    setAutoDefault = setFlat = lambda self, *a: None
    isDefault = autoDefault = isFlat = lambda self: False

    def setMenu(self, menu):
        self._menu = menu
        self.clicked.connect(lambda *_: menu.exec())

    menu = lambda self: getattr(self, "_menu", None)


class QToolButton(QPushButton):
    triggered = Signal(object)

    class ToolButtonPopupMode(enum.IntEnum):
        DelayedPopup = 0
        MenuButtonPopup = 1
        InstantPopup = 2

    DelayedPopup, MenuButtonPopup, InstantPopup = ToolButtonPopupMode.DelayedPopup, ToolButtonPopupMode.MenuButtonPopup, ToolButtonPopupMode.InstantPopup

    def setDefaultAction(self, act):
        self._action = act
        self._sync_action(act)
        act._q_hooks.append(self._sync_action)
        self.clicked.connect(lambda *_: (act.trigger(), self.triggered.emit(act)))

    def _sync_action(self, act):
        self.setText(act.text().replace("&", ""))
        self.setEnabled(act.isEnabled())
        if act.toolTip():
            self.setToolTip(act.toolTip())
        if not act.icon().isNull():
            self.setIcon(act.icon())

    defaultAction = lambda self: getattr(self, "_action", None)
    setToolButtonStyle = setPopupMode = setArrowType = setAutoRaise = lambda self, *a: None


class QCommandLinkButton(QPushButton):
    setDescription = lambda self, *a: None


class QCheckBox(QAbstractButton):
    stateChanged = Signal(int)
    checkStateChanged = Signal(object)

    def _make(self, wxparent):
        return wx.CheckBox(wxparent, label="")

    def _hook(self):
        self._w.Bind(wx.EVT_CHECKBOX, self._wx_changed)

    def _wx_changed(self, event=None):
        on = bool(self._w.GetValue())
        if on != self._checked:
            self._checked = on
            self._announce()
        self.clicked.emit(on)

    def _announce(self):
        self.toggled.emit(self._checked)
        self.stateChanged.emit(2 if self._checked else 0)
        self.checkStateChanged.emit(Qt.CheckState.Checked if self._checked else Qt.CheckState.Unchecked)

    def _set_checked(self, on):
        on = bool(on)
        self._w.SetValue(on)
        if on != self._checked:
            self._checked = on
            self._announce()

    def click(self):
        if self.isEnabled():
            self._w.SetValue(not self._checked)
            self._wx_changed()

    def checkState(self):
        return Qt.CheckState.Checked if self._checked else Qt.CheckState.Unchecked

    def setCheckState(self, state):
        self._set_checked(int(state) == 2)

    setTristate = lambda self, *a: None
    isTristate = lambda self: False


class QRadioButton(QAbstractButton):
    def _make(self, wxparent):
        w = wx.RadioButton(wxparent, label="")
        w.SetValue(False)
        return w

    def _hook(self):
        self._w.Bind(wx.EVT_RADIOBUTTON, self._wx_changed)
        self._q_host = None
        host = getattr(self._w, "_wx_parent", None)
        if host is not None:
            self._join(host)

    def _join(self, host):
        """Radio buttons with the same parent are one group, as in Qt."""
        if self._q_host is host:
            return
        if self._q_host is not None:
            peers = getattr(self._q_host, "_q_radios", [])
            if self in peers:
                peers.remove(self)
        self._q_host = host
        if not hasattr(host, "_q_radios"):
            host._q_radios = []
            host._q_radio_name = f"qrg{wx.NewId()}"
        host._q_radios.append(self)
        try:
            self._w.input.name = host._q_radio_name
        except Exception:
            pass

    def _peers(self):
        if self._group is not None:
            return [b for b in self._group._buttons if isinstance(b, QRadioButton)]
        return list(getattr(self._q_host, "_q_radios", [self])) if self._q_host is not None else [self]

    def _settle(self, chosen):
        """One button of the group became checked: the others are not, and each that changed says so."""
        changed = []
        for b in self._peers():
            want = b is chosen
            try:
                b._w.SetValue(want)
            except Exception:
                pass
            if b._checked != want:
                b._checked = want
                changed.append(b)
        for b in sorted(changed, key=lambda b: b._checked):       # the one switched off reports first
            b.toggled.emit(b._checked)

    def _wx_changed(self, event=None):
        if self._w.GetValue():
            self._settle(self)
        self.clicked.emit(self._checked)

    def _set_checked(self, on):
        if on:
            self._settle(self)
        elif self._checked:
            self._checked = False
            self._w.SetValue(False)
            self.toggled.emit(False)

    def click(self):
        if self.isEnabled():
            self._settle(self)
            self.clicked.emit(True)


class QButtonGroup(QObject):
    buttonClicked = Signal(object)
    buttonToggled = Signal(object, bool)
    idClicked = Signal(int)
    idToggled = Signal(int, bool)

    def __init__(self, parent=None):
        QObject.__init__(self, parent)
        self._buttons, self._ids, self._excl = [], {}, True

    def addButton(self, b, id=-1):
        self._buttons.append(b)
        if id == -1:
            id = -2 - (len(self._buttons) - 1)
        self._ids[b] = id
        b._group = self
        b.clicked.connect(lambda *_: (self.buttonClicked.emit(b), self.idClicked.emit(self._ids.get(b, -1))))
        b.toggled.connect(lambda on: (self.buttonToggled.emit(b, on), self.idToggled.emit(self._ids.get(b, -1), on)))

    def removeButton(self, b):
        if b in self._buttons:
            self._buttons.remove(b)
            self._ids.pop(b, None)
            b._group = None

    def _exclusive(self, chosen):
        if not self._excl:
            return
        for b in self._buttons:
            if b is not chosen and b.isChecked() and not isinstance(b, QRadioButton):
                b._set_checked(False)

    def setExclusive(self, on):
        self._excl = bool(on)

    exclusive = lambda self: self._excl
    buttons = lambda self: list(self._buttons)
    button = lambda self, id: next((b for b, i in self._ids.items() if i == id), None)
    id = lambda self, b: self._ids.get(b, -1)
    setId = lambda self, b, id: self._ids.__setitem__(b, id)
    checkedButton = lambda self: next((b for b in self._buttons if b.isChecked()), None)

    def checkedId(self):
        b = self.checkedButton()
        return self._ids.get(b, -1) if b is not None else -1


class QLineEdit(QWidget):
    textChanged = Signal(str)
    textEdited = Signal(str)
    editingFinished = Signal()
    returnPressed = Signal()
    selectionChanged = Signal()
    cursorPositionChanged = Signal(int, int)

    class EchoMode(enum.IntEnum):
        Normal = 0
        NoEcho = 1
        Password = 2
        PasswordEchoOnEdit = 3

    class ActionPosition(enum.IntEnum):
        LeadingPosition = 0
        TrailingPosition = 1

    Normal, NoEcho, Password, PasswordEchoOnEdit = EchoMode.Normal, EchoMode.NoEcho, EchoMode.Password, EchoMode.PasswordEchoOnEdit
    LeadingPosition, TrailingPosition = ActionPosition.LeadingPosition, ActionPosition.TrailingPosition
    _EXPAND = _H

    def __init__(self, *a, **k):
        text = next((x for x in a if isinstance(x, str)), k.get("text", ""))
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), k.get("parent")))
        self._last = ""
        self._validator = None
        self._w.Bind(wx.EVT_TEXT, self._wx_text)
        self._w.Bind(wx.EVT_TEXT_ENTER, self._wx_enter)
        try:
            wx._listen(self._input(), "change", lambda *_: self.editingFinished.emit())
        except Exception:
            pass
        if text:
            self.setText(text)

    def _make(self, wxparent):
        return wx.TextCtrl(wxparent, value="", style=wx.TE_PROCESS_ENTER)

    def _input(self):
        return getattr(self._w, "input", None) or self._w.el

    def _wx_text(self, event=None):
        now = self._w.GetValue()
        if now != self._last:
            self._last = now
            self.textEdited.emit(now)
            self.textChanged.emit(now)

    def _wx_enter(self, event=None):
        self._wx_text()
        self.returnPressed.emit()
        self.editingFinished.emit()

    def text(self):
        return self._w.GetValue()

    displayText = text

    def setText(self, text):
        text = _text_of(text)
        self._w.SetValue(text)
        if text != self._last:
            self._last = text
            self.textChanged.emit(text)

    def clear(self):
        self.setText("")

    def insert(self, text):
        self.setText(self.text() + _text_of(text))

    def setPlaceholderText(self, text):
        self._hint = _text_of(text)
        self._w.SetHint(self._hint)

    placeholderText = lambda self: getattr(self, "_hint", "")

    def setReadOnly(self, on):
        self._ro = bool(on)
        self._w.SetEditable(not on)

    isReadOnly = lambda self: getattr(self, "_ro", False)

    def setMaxLength(self, n):
        self._w.SetMaxLength(int(n))

    def setEchoMode(self, mode):
        try:
            self._input().type = "password" if int(mode) in (2, 3) else "text"
        except Exception:
            pass

    def setValidator(self, v):
        self._validator = v

    validator = lambda self: self._validator

    def hasAcceptableInput(self):
        if self._validator is None:
            return True
        return int(self._validator.validate(self.text(), 0)[0]) == 2

    def selectAll(self):
        self._w.SelectAll()

    def setAlignment(self, al):
        try:
            self._input().style.textAlign = "center" if int(al) & 0x4 else ("right" if int(al) & 0x2 else "")
        except Exception:
            pass

    setClearButtonEnabled = setCompleter = setInputMask = setCursorPosition = setFrame = setTextMargins = setSelection = setModified = \
        setDragEnabled = deselect = home = end = lambda self, *a: None
    isModified = hasSelectedText = lambda self: False
    selectedText = lambda self: ""
    cursorPosition = lambda self: len(self.text())
    maxLength = lambda self: 32767
    completer = lambda self: None


class _TextBox(QWidget):
    textChanged = Signal()
    cursorPositionChanged = Signal()
    selectionChanged = Signal()
    _EXPAND = _H | _V

    class LineWrapMode(enum.IntEnum):
        NoWrap = 0
        WidgetWidth = 1
        FixedPixelWidth = 2
        FixedColumnWidth = 3

    NoWrap, WidgetWidth = LineWrapMode.NoWrap, LineWrapMode.WidgetWidth

    def __init__(self, *a, **k):
        text = next((x for x in a if isinstance(x, str)), "")
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), k.get("parent")))
        self._w.Bind(wx.EVT_TEXT, lambda e=None: self.textChanged.emit())
        self._doc = None
        if text:
            self.setPlainText(text)

    def _make(self, wxparent):
        return wx.TextCtrl(wxparent, value="", style=wx.TE_MULTILINE)

    def toPlainText(self):
        return self._w.GetValue()

    toHtml = toMarkdown = toPlainText

    def setPlainText(self, text):
        self._w.SetValue(_text_of(text))
        self.textChanged.emit()

    setText = setMarkdown = setPlainText

    def setHtml(self, html):
        self.setPlainText(_plain(html))

    def append(self, text):
        text = _plain(text) if _rich(text) else _text_of(text)
        cur = self._w.GetValue()
        self._w.SetValue(cur + ("\n" if cur else "") + text)
        self._bottom()
        self.textChanged.emit()

    appendPlainText = append

    def appendHtml(self, html):
        self.append(_plain(html))

    def insertPlainText(self, text):
        self._w.SetValue(self._w.GetValue() + _text_of(text))
        self._bottom()
        self.textChanged.emit()

    def insertHtml(self, html):
        self.insertPlainText(_plain(html))

    def _bottom(self):
        try:
            el = getattr(self._w, "input", None) or self._w.el
            el.scrollTop = el.scrollHeight
        except Exception:
            pass

    def clear(self):
        self._w.SetValue("")
        self.textChanged.emit()

    def setReadOnly(self, on):
        self._ro = bool(on)
        self._w.SetEditable(not on)

    isReadOnly = lambda self: getattr(self, "_ro", False)

    def setPlaceholderText(self, text):
        self._w.SetHint(_text_of(text))

    def textCursor(self):
        return QtGui.QTextCursor(self)

    def document(self):
        if self._doc is None:
            self._doc = _Doc(self)
        return self._doc

    def verticalScrollBar(self):
        return QScrollBar._of(self)

    horizontalScrollBar = verticalScrollBar

    def selectAll(self):
        self._w.SelectAll()

    def setLineWrapMode(self, mode):
        try:
            (getattr(self._w, "input", None) or self._w.el).style.whiteSpace = "pre" if int(mode) == 0 else "pre-wrap"
        except Exception:
            pass

    setTextCursor = moveCursor = ensureCursorVisible = setAcceptRichText = setWordWrapMode = setTabStopDistance = setCurrentFont = \
        setTextColor = setFontWeight = setFontPointSize = setTextBackgroundColor = setCurrentCharFormat = setUndoRedoEnabled = \
        setMaximumBlockCount = setCenterOnScroll = setTabChangesFocus = setOverwriteMode = setDocument = setOpenExternalLinks = setOpenLinks = \
        setVerticalScrollBarPolicy = setHorizontalScrollBarPolicy = setFrameShape = setFrameStyle = setFrameShadow = setLineWidth = \
        setSource = setSearchPaths = copy = cut = paste = undo = redo = setAlignment = zoomIn = zoomOut = setViewportMargins = \
        setCursorWidth = setExtraSelections = centerCursor = scrollToAnchor = lambda self, *a: None
    blockCount = lambda self: self._w.GetValue().count("\n") + 1
    viewport = lambda self: self
    canPaste = lambda self: True
    find = lambda self, *a: False
    anchorClicked = Signal(object)


class _Doc(QtGui.QTextDocument):
    def __init__(self, edit):
        QtGui.QTextDocument.__init__(self)
        self._edit = edit

    def setPlainText(self, t):
        self._edit.setPlainText(t)

    setHtml = lambda self, t: self._edit.setHtml(t)
    toPlainText = toHtml = lambda self: self._edit.toPlainText()
    blockCount = lambda self: self._edit.blockCount()
    isEmpty = lambda self: not self._edit.toPlainText()


class QTextEdit(_TextBox):
    pass


class QPlainTextEdit(_TextBox):
    pass


class QTextBrowser(_TextBox):
    def __init__(self, *a, **k):
        _TextBox.__init__(self, *a, **k)
        self.setReadOnly(True)


class QScrollBar(QWidget):
    valueChanged = Signal(int)
    rangeChanged = Signal(int, int)
    sliderMoved = Signal(int)

    @staticmethod
    def _of(owner):
        bar = getattr(owner, "_q_bar", None)
        if bar is None:
            bar = owner._q_bar = QScrollBar.__new__(QScrollBar)
            QObject.__init__(bar)
            bar._el = getattr(owner._w, "input", None) or owner._w.el
        return bar

    def _get(self, name, fallback=0):
        try:
            return int(getattr(self._el, name) or 0)
        except Exception:
            return fallback

    def value(self):
        return self._get("scrollTop")

    def setValue(self, v):
        try:
            self._el.scrollTop = int(v)
        except Exception:
            pass

    setSliderPosition = setValue
    sliderPosition = value

    def maximum(self):
        return max(0, self._get("scrollHeight") - self._get("clientHeight"))

    minimum = lambda self: 0
    pageStep = lambda self: self._get("clientHeight")
    singleStep = lambda self: 20
    setRange = setMaximum = setMinimum = setPageStep = setSingleStep = setVisible = setEnabled = setStyleSheet = hide = show = lambda self, *a: None
    isVisible = lambda self: True


class QComboBox(QWidget):
    currentIndexChanged = Signal(int)
    currentTextChanged = Signal(str)
    activated = Signal(int)
    textActivated = Signal(str)
    editTextChanged = Signal(str)
    highlighted = Signal(int)

    class InsertPolicy(enum.IntEnum):
        NoInsert = 0
        InsertAtTop = 1
        InsertAtCurrent = 2
        InsertAtBottom = 3
        InsertAfterCurrent = 4
        InsertBeforeCurrent = 5
        InsertAlphabetically = 6

    class SizeAdjustPolicy(enum.IntEnum):
        AdjustToContents = 0
        AdjustToContentsOnFirstShow = 1
        AdjustToMinimumContentsLengthWithIcon = 2

    NoInsert, InsertAtTop, InsertAtBottom = InsertPolicy.NoInsert, InsertPolicy.InsertAtTop, InsertPolicy.InsertAtBottom
    AdjustToContents, AdjustToContentsOnFirstShow, AdjustToMinimumContentsLengthWithIcon = (
        SizeAdjustPolicy.AdjustToContents, SizeAdjustPolicy.AdjustToContentsOnFirstShow, SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)

    def __init__(self, parent=None, **k):
        QWidget.__init__(self, parent)
        self._data = []
        self._idx = -1
        self._editable = False
        self._w.Bind(wx.EVT_CHOICE, self._wx_chosen)

    def _make(self, wxparent):
        return wx.Choice(wxparent)

    def _wx_chosen(self, event=None):
        i = self._w.GetSelection()
        changed = i != self._idx
        self._idx = i
        if changed:
            self._announce()
        self.activated.emit(i)
        self.textActivated.emit(self.currentText())

    def _announce(self):
        self.currentIndexChanged.emit(self._idx)
        self.currentTextChanged.emit(self.currentText())

    def _settle(self, want):
        """Show index `want`, and tell listeners when the current item is another one than before."""
        n = self._w.GetCount()
        want = -1 if n == 0 else max(-1, min(n - 1, want))
        old_text = getattr(self, "_shown_text", None)
        if want >= 0:
            self._w.SetSelection(want)
        changed = want != self._idx or (self.itemText(want) if want >= 0 else "") != (old_text or "")
        self._idx = want
        self._shown_text = self.itemText(want) if want >= 0 else ""
        if changed:
            self._announce()

    def addItem(self, *a):
        self.insertItem(self.count(), *a)

    def insertItem(self, index, *a):
        a = [x for x in a if not isinstance(x, QIcon)]
        text = _text_of(a[0]) if a else ""
        data = a[1] if len(a) > 1 else None
        index = max(0, min(self.count(), index))
        if index >= self.count():
            self._w.Append(text)
        else:
            self._w.Insert(text, index)
        self._data.insert(index, data)
        cur = self._idx
        if cur < 0:
            self._settle(0)
        elif index <= cur:
            self._idx = cur + 1
            self._w.SetSelection(self._idx)

    def addItems(self, texts):
        for t in texts:
            self.addItem(t)

    def insertItems(self, index, texts):
        for i, t in enumerate(texts):
            self.insertItem(index + i, t)

    def removeItem(self, i):
        if 0 <= i < self.count():
            self._w.Delete(i)
            del self._data[i]
            cur = self._idx
            self._idx = -2
            self._settle(cur - 1 if i < cur else min(cur, self.count() - 1))

    def clear(self):
        had = self._idx
        self._w.Clear()
        self._data = []
        self._idx = -1
        self._shown_text = ""
        if had != -1:
            self._announce()

    def count(self):
        return self._w.GetCount()

    def currentIndex(self):
        return self._idx

    def setCurrentIndex(self, i):
        if i != self._idx:
            self._settle(i)

    def currentText(self):
        if self._editable and getattr(self, "_edit_text", None) is not None:
            return self._edit_text
        return self._w.GetString(self._idx) if 0 <= self._idx < self.count() else ""

    def setCurrentText(self, text):
        i = self.findText(_text_of(text))
        if i >= 0:
            self.setCurrentIndex(i)
        elif self._editable:
            self._edit_text = _text_of(text)

    setEditText = setCurrentText

    def currentData(self, role=0x100):
        return self._data[self._idx] if 0 <= self._idx < len(self._data) else None

    def itemText(self, i):
        return self._w.GetString(i) if 0 <= i < self.count() else ""

    def itemData(self, i, role=0x100):
        return self._data[i] if 0 <= i < len(self._data) else None

    def setItemText(self, i, text):
        if 0 <= i < self.count():
            self._w.SetString(i, _text_of(text))

    def setItemData(self, i, data, role=0x100):
        if 0 <= i < len(self._data) and int(role) == 0x100:
            self._data[i] = data

    def findText(self, text, flags=None):
        for i in range(self.count()):
            if self._w.GetString(i) == text:
                return i
        return -1

    def findData(self, data, role=0x100, flags=None):
        for i, d in enumerate(self._data):
            if d == data:
                return i
        return -1

    def setEditable(self, on):
        self._editable = bool(on)

    isEditable = lambda self: self._editable
    lineEdit = lambda self: None
    setItemIcon = setInsertPolicy = setSizeAdjustPolicy = setMinimumContentsLength = setMaxVisibleItems = setIconSize = setDuplicatesEnabled = \
        setModel = setView = setCompleter = setValidator = setFrame = setMaxCount = setPlaceholderText = setItemDelegate = showPopup = hidePopup = \
        setModelColumn = lambda self, *a: None
    maxVisibleItems = lambda self: 10
    view = lambda self: self
    model = lambda self: None


class QFontComboBox(QComboBox):
    currentFont = lambda self: QFont()
    setCurrentFont = lambda self, *a: None


class QAbstractSpinBox(QWidget):
    editingFinished = Signal()

    class ButtonSymbols(enum.IntEnum):
        UpDownArrows = 0
        PlusMinus = 1
        NoButtons = 2

    UpDownArrows, PlusMinus, NoButtons = ButtonSymbols.UpDownArrows, ButtonSymbols.PlusMinus, ButtonSymbols.NoButtons
    setButtonSymbols = setAlignment = setReadOnly = setKeyboardTracking = setAccelerated = setWrapping = setSpecialValueText = \
        setCorrectionMode = setFrame = setGroupSeparatorShown = selectAll = stepUp = stepDown = interpretText = lambda self, *a: None


class QSpinBox(QAbstractSpinBox):
    valueChanged = Signal(int)
    textChanged = Signal(str)
    _FLOAT = False

    def __init__(self, parent=None, **k):
        QWidget.__init__(self, parent)
        self._lo, self._hi = 0, 99
        self._last = 0
        self._w.Bind(wx.EVT_SPINCTRLDOUBLE if self._FLOAT else wx.EVT_SPINCTRL, self._wx_changed)
        self._w.SetRange(self._lo, self._hi)

    def _make(self, wxparent):
        return wx.SpinCtrlDouble(wxparent) if self._FLOAT else wx.SpinCtrl(wxparent)

    def _cast(self, v):
        return float(v) if self._FLOAT else int(round(float(v)))

    def _wx_changed(self, event=None):
        v = self._cast(self._w.GetValue())
        if v != self._last:
            self._last = v
            self.valueChanged.emit(v)
            self.textChanged.emit(str(v))

    def value(self):
        return self._cast(self._w.GetValue())

    def setValue(self, v):
        v = max(self._lo, min(self._hi, self._cast(v)))
        self._w.SetValue(v)
        if v != self._last:
            self._last = v
            self.valueChanged.emit(v)
            self.textChanged.emit(str(v))

    def setRange(self, lo, hi):
        self._lo, self._hi = self._cast(lo), self._cast(hi)
        self._w.SetRange(self._lo, self._hi)
        if not self._lo <= self._last <= self._hi:
            self.setValue(self._last)

    def setMinimum(self, lo):
        self.setRange(lo, max(self._hi, self._cast(lo)))

    def setMaximum(self, hi):
        self.setRange(min(self._lo, self._cast(hi)), hi)

    minimum = lambda self: self._lo
    maximum = lambda self: self._hi

    def setSingleStep(self, step):
        self._step = step
        self._w.SetIncrement(step)

    singleStep = lambda self: getattr(self, "_step", 1)

    def setSuffix(self, s):
        self._suffix = _text_of(s)
        if self._suffix.strip():
            self._w.SetToolTip(self._suffix.strip())

    def setPrefix(self, s):
        self._prefix = _text_of(s)

    suffix = lambda self: getattr(self, "_suffix", "")
    prefix = lambda self: getattr(self, "_prefix", "")
    text = cleanText = lambda self: str(self.value())
    setDisplayIntegerBase = setStepType = lambda self, *a: None
    lineEdit = lambda self: None


class QDoubleSpinBox(QSpinBox):
    valueChanged = Signal(float)
    _FLOAT = True

    def __init__(self, parent=None, **k):
        QSpinBox.__init__(self, parent)
        self._lo, self._hi = 0.0, 99.99
        self._w.SetRange(self._lo, self._hi)
        self._decimals = 2

    def setDecimals(self, n):
        self._decimals = int(n)
        self._w.SetDigits(int(n))

    decimals = lambda self: self._decimals


class QAbstractSlider(QWidget):
    valueChanged = Signal(int)
    sliderMoved = Signal(int)
    sliderPressed = Signal()
    sliderReleased = Signal()
    rangeChanged = Signal(int, int)
    _EXPAND = _H

    def __init__(self, *a, **k):
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))
        self._lo, self._hi, self._last = 0, 99, 0
        self._w.SetRange(0, 99)
        self._w.Bind(wx.EVT_SLIDER, self._wx_changed)

    def _make(self, wxparent):
        return wx.Slider(wxparent, value=0, minValue=0, maxValue=99)

    def _wx_changed(self, event=None):
        v = int(self._w.GetValue())
        if v != self._last:
            self._last = v
            self.sliderMoved.emit(v)
            self.valueChanged.emit(v)

    def value(self):
        return int(self._w.GetValue())

    sliderPosition = value

    def setValue(self, v):
        v = max(self._lo, min(self._hi, int(v)))
        self._w.SetValue(v)
        if v != self._last:
            self._last = v
            self.valueChanged.emit(v)

    setSliderPosition = setValue

    def setRange(self, lo, hi):
        self._lo, self._hi = int(lo), int(hi)
        self._w.SetRange(self._lo, self._hi)
        self.rangeChanged.emit(self._lo, self._hi)

    def setMinimum(self, lo):
        self.setRange(lo, max(self._hi, lo))

    def setMaximum(self, hi):
        self.setRange(min(self._lo, hi), hi)

    minimum = lambda self: self._lo
    maximum = lambda self: self._hi
    setSingleStep = setPageStep = setTracking = setOrientation = setInvertedAppearance = setInvertedControls = setTickPosition = setTickInterval = lambda self, *a: None
    orientation = lambda self: Qt.Orientation.Horizontal


class QSlider(QAbstractSlider):
    class TickPosition(enum.IntEnum):
        NoTicks = 0
        TicksAbove = 1
        TicksBelow = 2
        TicksBothSides = 3

    NoTicks, TicksAbove, TicksBelow, TicksBothSides = TickPosition.NoTicks, TickPosition.TicksAbove, TickPosition.TicksBelow, TickPosition.TicksBothSides
    TicksLeft, TicksRight = TickPosition.TicksAbove, TickPosition.TicksBelow


class QDial(QAbstractSlider):
    setNotchesVisible = setWrapping = lambda self, *a: None


class QProgressBar(QWidget):
    valueChanged = Signal(int)
    _EXPAND = _H

    def __init__(self, parent=None, **k):
        QWidget.__init__(self, parent)
        self._lo, self._hi, self._v = 0, 100, -1

    def _make(self, wxparent):
        return wx.Gauge(wxparent, range=100)

    def setRange(self, lo, hi):
        self._lo, self._hi = int(lo), int(hi)
        if self._hi <= self._lo:
            self._w.Pulse()
        else:
            self._w.SetRange(self._hi - self._lo)
            self._w.SetValue(max(0, self._v - self._lo))

    def setMinimum(self, lo):
        self.setRange(lo, self._hi)

    def setMaximum(self, hi):
        self.setRange(self._lo, hi)

    def setValue(self, v):
        self._v = int(v)
        if self._hi > self._lo:
            self._w.SetValue(max(0, min(self._hi - self._lo, self._v - self._lo)))
        self.valueChanged.emit(self._v)
        wx.Yield()

    def reset(self):
        self._v = self._lo - 1
        self._w.SetValue(0)

    value = lambda self: self._v
    minimum = lambda self: self._lo
    maximum = lambda self: self._hi
    setFormat = setTextVisible = setOrientation = setInvertedAppearance = setAlignment = lambda self, *a: None
    text = lambda self: f"{int(100 * (self._v - self._lo) / max(1, self._hi - self._lo))}%"
    isTextVisible = lambda self: True


# ----------------------------------------------------------------------------- containers

class QGroupBox(QWidget):
    toggled = Signal(bool)
    clicked = Signal(bool)

    def __init__(self, *a, **k):
        title = next((x for x in a if isinstance(x, str)), k.get("title", ""))
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), k.get("parent")))
        self._title = ""
        if title:
            self.setTitle(title)

    def _make(self, wxparent):
        box = wx.StaticBox(wxparent, label="")
        box.el.style.minWidth = "0"
        return box

    def setTitle(self, t):
        self._title = _text_of(t)
        self._w.SetLabel(self._title.replace("&", ""))

    title = lambda self: self._title
    setCheckable = setFlat = setAlignment = lambda self, *a: None
    isCheckable = lambda self: False
    isChecked = lambda self: True

    def setChecked(self, on):
        self.setEnabled(on)


class QAbstractScrollArea(QFrame):
    _EXPAND = _H | _V

    def _make(self, wxparent):
        return wx.ScrolledWindow(wxparent)

    def verticalScrollBar(self):
        return QScrollBar._of(self)

    horizontalScrollBar = verticalScrollBar
    viewport = lambda self: self
    setVerticalScrollBarPolicy = setHorizontalScrollBarPolicy = setSizeAdjustPolicy = setViewportMargins = setCornerWidget = lambda self, *a: None

    class SizeAdjustPolicy(enum.IntEnum):
        AdjustIgnored = 0
        AdjustToContentsOnFirstShow = 1
        AdjustToContents = 2

    AdjustIgnored, AdjustToContentsOnFirstShow, AdjustToContents = SizeAdjustPolicy.AdjustIgnored, SizeAdjustPolicy.AdjustToContentsOnFirstShow, SizeAdjustPolicy.AdjustToContents


class QScrollArea(QAbstractScrollArea):
    def __init__(self, parent=None, **k):
        QWidget.__init__(self, parent)
        self._inner = None
        self._box = wx.BoxSizer(wx.VERTICAL)
        self._w.SetSizer(self._box)

    def setWidget(self, w):
        if self._inner is not None:
            self.takeWidget()
        self._inner = w
        QObject.setParent(w, self)
        _wx_reparent(w._w, self._w)
        self._box.Add(w._w, 1, wx.EXPAND)
        w._q_visible = True

    def widget(self):
        return self._inner

    def takeWidget(self):
        w, self._inner = self._inner, None
        if w is not None:
            try:
                self._box.Detach(w._w)
            except Exception:
                pass
            w._detach()
        return w

    setWidgetResizable = setAlignment = ensureVisible = ensureWidgetVisible = lambda self, *a: None
    widgetResizable = lambda self: True


class QStackedWidget(QFrame):
    currentChanged = Signal(int)
    widgetRemoved = Signal(int)
    _EXPAND = _H | _V

    def __init__(self, parent=None, **k):
        QWidget.__init__(self, parent)
        self._pages = []
        self._index = -1
        self._box = wx.BoxSizer(wx.VERTICAL)
        self._w.SetSizer(self._box)

    def addWidget(self, w):
        return self.insertWidget(len(self._pages), w)

    def insertWidget(self, index, w):
        QObject.setParent(w, self)
        _wx_reparent(w._w, self._w)
        self._box.Add(w._w, 1, wx.EXPAND)
        index = max(0, min(len(self._pages), index))
        self._pages.insert(index, w)
        w._q_visible = True
        if self._index < 0:
            self._index = 0
            self.currentChanged.emit(0)
        elif index <= self._index:
            self._index += 1
        self._sync()
        return index

    def _sync(self):
        for i, p in enumerate(self._pages):
            p._w.Show(i == self._index)

    def removeWidget(self, w):
        if w in self._pages:
            i = self._pages.index(w)
            self._pages.remove(w)
            try:
                self._box.Detach(w._w)
            except Exception:
                pass
            w._detach()
            self._index = min(self._index, len(self._pages) - 1)
            self._sync()
            self.widgetRemoved.emit(i)

    def setCurrentIndex(self, i):
        if 0 <= i < len(self._pages) and i != self._index:
            self._index = i
            self._sync()
            self.currentChanged.emit(i)

    def setCurrentWidget(self, w):
        if w in self._pages:
            self.setCurrentIndex(self._pages.index(w))

    currentIndex = lambda self: self._index
    currentWidget = lambda self: self._pages[self._index] if 0 <= self._index < len(self._pages) else None
    widget = lambda self, i: self._pages[i] if 0 <= i < len(self._pages) else None
    count = lambda self: len(self._pages)
    indexOf = lambda self, w: self._pages.index(w) if w in self._pages else -1


class QTabWidget(QWidget):
    currentChanged = Signal(int)
    tabCloseRequested = Signal(int)
    tabBarClicked = Signal(int)
    _EXPAND = _H | _V

    class TabPosition(enum.IntEnum):
        North = 0
        South = 1
        West = 2
        East = 3

    class TabShape(enum.IntEnum):
        Rounded = 0
        Triangular = 1

    North, South, West, East = TabPosition.North, TabPosition.South, TabPosition.West, TabPosition.East

    def __init__(self, parent=None, **k):
        QWidget.__init__(self, parent)
        self._pages = []
        self._w.Bind(wx.EVT_NOTEBOOK_PAGE_CHANGED, lambda e=None: self.currentChanged.emit(self._w.GetSelection()))

    def _make(self, wxparent):
        return wx.Notebook(wxparent)

    def addTab(self, w, *a):
        return self.insertTab(len(self._pages), w, *a)

    def insertTab(self, index, w, *a):
        text = next((x for x in a if isinstance(x, str)), "")
        QObject.setParent(w, self)
        _wx_reparent(w._w, None)
        w._w._wx_parent = self._w
        first = not self._pages
        index = max(0, min(len(self._pages), index))
        self._w.InsertPage(index, w._w, text.replace("&", ""), first)
        self._pages.insert(index, w)
        w._q_visible = True
        if first:
            self.currentChanged.emit(0)
        return index

    def removeTab(self, i):
        if 0 <= i < len(self._pages):
            self._w.RemovePage(i)
            del self._pages[i]

    def clear(self):
        while self._pages:
            self.removeTab(0)

    def currentIndex(self):
        return self._w.GetSelection() if self._pages else -1

    def setCurrentIndex(self, i):
        if 0 <= i < len(self._pages) and i != self._w.GetSelection():
            self._w.SetSelection(i)
            self.currentChanged.emit(i)

    def setCurrentWidget(self, w):
        if w in self._pages:
            self.setCurrentIndex(self._pages.index(w))

    currentWidget = lambda self: self._pages[self.currentIndex()] if self._pages else None
    widget = lambda self, i: self._pages[i] if 0 <= i < len(self._pages) else None
    count = lambda self: len(self._pages)
    indexOf = lambda self, w: self._pages.index(w) if w in self._pages else -1
    tabText = lambda self, i: self._w.GetPageText(i) if 0 <= i < len(self._pages) else ""

    def setTabText(self, i, text):
        if 0 <= i < len(self._pages):
            self._w.SetPageText(i, _text_of(text).replace("&", ""))

    def setTabEnabled(self, i, on):
        if 0 <= i < len(self._pages):
            self._pages[i].setEnabled(on)

    isTabEnabled = isTabVisible = lambda self, i: True
    tabBar = lambda self: self
    setTabToolTip = setTabIcon = setTabPosition = setTabShape = setMovable = setTabsClosable = setDocumentMode = setUsesScrollButtons = \
        setElideMode = setTabBarAutoHide = setCornerWidget = setTabVisible = setIconSize = setExpanding = setDrawBase = lambda self, *a: None


class QSplitter(QFrame):
    splitterMoved = Signal(int, int)
    _EXPAND = _H | _V

    def __init__(self, *a, **k):
        orient = next((x for x in a if isinstance(x, Qt.Orientation)), Qt.Orientation.Horizontal)
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))
        self._orient = orient
        self._parts = []
        self._box = wx.BoxSizer(wx.HORIZONTAL if int(orient) == 1 else wx.VERTICAL)
        self._box.el.style.gap = "6px"
        self._w.SetSizer(self._box)

    def addWidget(self, w):
        self.insertWidget(len(self._parts), w)

    def insertWidget(self, index, w):
        QObject.setParent(w, self)
        _wx_reparent(w._w, self._w)
        self._box.Add(w._w, 1, wx.EXPAND)
        self._parts.append(w)
        w._q_visible = True

    def setOrientation(self, orient):
        self._orient = orient

    def setSizes(self, sizes):
        for w, s in zip(self._parts, sizes):
            try:
                holder = w._w.el.parentNode if w._w.el.parentNode is not self._box.el else w._w.el
                holder.style.flex = f"{max(1, int(s))} 1 0%"
            except Exception:
                pass

    def setStretchFactor(self, index, n):
        if 0 <= index < len(self._parts):
            try:
                w = self._parts[index]
                holder = w._w.el.parentNode if w._w.el.parentNode is not self._box.el else w._w.el
                holder.style.flex = f"{max(1, int(n))} 1 0%" if n else "0 1 auto"
            except Exception:
                pass

    sizes = lambda self: [p.width() for p in self._parts]
    count = lambda self: len(self._parts)
    widget = lambda self, i: self._parts[i] if 0 <= i < len(self._parts) else None
    indexOf = lambda self, w: self._parts.index(w) if w in self._parts else -1
    orientation = lambda self: self._orient
    setChildrenCollapsible = setCollapsible = setHandleWidth = setOpaqueResize = restoreState = lambda self, *a: None
    saveState = lambda self: QtCore.QByteArray(b"")
    handle = lambda self, i: self


# ----------------------------------------------------------------------------- item views

class QAbstractItemView(QAbstractScrollArea):
    clicked = Signal(object)
    doubleClicked = Signal(object)
    activated = Signal(object)
    pressed = Signal(object)
    entered = Signal(object)

    class SelectionMode(enum.IntEnum):
        NoSelection = 0
        SingleSelection = 1
        MultiSelection = 2
        ExtendedSelection = 3
        ContiguousSelection = 4

    class SelectionBehavior(enum.IntEnum):
        SelectItems = 0
        SelectRows = 1
        SelectColumns = 2

    class EditTrigger(enum.IntFlag):
        NoEditTriggers = 0
        CurrentChanged = 1
        DoubleClicked = 2
        SelectedClicked = 4
        EditKeyPressed = 8
        AnyKeyPressed = 16
        AllEditTriggers = 31

    class ScrollMode(enum.IntEnum):
        ScrollPerItem = 0
        ScrollPerPixel = 1

    class ScrollHint(enum.IntEnum):
        EnsureVisible = 0
        PositionAtTop = 1
        PositionAtBottom = 2
        PositionAtCenter = 3

    class DragDropMode(enum.IntEnum):
        NoDragDrop = 0
        DragOnly = 1
        DropOnly = 2
        DragDrop = 3
        InternalMove = 4

    NoSelection, SingleSelection, MultiSelection, ExtendedSelection, ContiguousSelection = (
        SelectionMode.NoSelection, SelectionMode.SingleSelection, SelectionMode.MultiSelection, SelectionMode.ExtendedSelection, SelectionMode.ContiguousSelection)
    SelectItems, SelectRows, SelectColumns = SelectionBehavior.SelectItems, SelectionBehavior.SelectRows, SelectionBehavior.SelectColumns
    NoEditTriggers, CurrentChanged, DoubleClicked, SelectedClicked, EditKeyPressed, AnyKeyPressed, AllEditTriggers = (
        EditTrigger.NoEditTriggers, EditTrigger.CurrentChanged, EditTrigger.DoubleClicked, EditTrigger.SelectedClicked,
        EditTrigger.EditKeyPressed, EditTrigger.AnyKeyPressed, EditTrigger.AllEditTriggers)
    ScrollPerItem, ScrollPerPixel = ScrollMode.ScrollPerItem, ScrollMode.ScrollPerPixel
    EnsureVisible, PositionAtTop, PositionAtBottom, PositionAtCenter = ScrollHint.EnsureVisible, ScrollHint.PositionAtTop, ScrollHint.PositionAtBottom, ScrollHint.PositionAtCenter
    NoDragDrop, DragOnly, DropOnly, DragDrop, InternalMove = DragDropMode.NoDragDrop, DragDropMode.DragOnly, DragDropMode.DropOnly, DragDropMode.DragDrop, DragDropMode.InternalMove


class QHeaderView(QObject):
    sectionClicked = Signal(int)
    sectionResized = Signal(int, int, int)
    sectionMoved = Signal(int, int, int)
    sortIndicatorChanged = Signal(int, object)

    class ResizeMode(enum.IntEnum):
        Interactive = 0
        Stretch = 1
        Fixed = 2
        ResizeToContents = 3

    Interactive, Stretch, Fixed, ResizeToContents = ResizeMode.Interactive, ResizeMode.Stretch, ResizeMode.Fixed, ResizeMode.ResizeToContents

    def __init__(self, view, orientation):
        QObject.__init__(self)
        self._view, self._orient, self._shown = view, orientation, True
        self._modes = {}
        self._hidden = set()

    def count(self):
        return self._view._ncols() if int(self._orient) == 1 else self._view._nrows()

    length = count
    logicalIndex = visualIndex = lambda self, i: i

    def setVisible(self, on):
        self._shown = bool(on)
        self._view._render()

    def hide(self):
        self.setVisible(False)

    def show(self):
        self.setVisible(True)

    isVisible = lambda self: self._shown
    isHidden = lambda self: not self._shown

    def setSectionResizeMode(self, *a):
        if len(a) == 2:
            self._modes[int(a[0])] = a[1]
        elif a:
            self._modes[None] = a[0]
        self._view._render()

    def _stretches(self, col, last):
        mode = self._modes.get(col, self._modes.get(None))
        return (mode is not None and int(mode) == 1) or (last and getattr(self, "_stretch_last", False))

    def setStretchLastSection(self, on):
        self._stretch_last = bool(on)
        self._view._render()

    def setSectionHidden(self, i, hide):
        (self._hidden.add if hide else self._hidden.discard)(int(i))
        self._view._render()

    hideSection = lambda self, i: self.setSectionHidden(i, True)
    showSection = lambda self, i: self.setSectionHidden(i, False)
    isSectionHidden = lambda self, i: int(i) in self._hidden
    sectionSize = defaultSectionSize = lambda self, *a: 100
    sectionResizeMode = lambda self, i: self._modes.get(int(i), QHeaderView.ResizeMode.Interactive)
    stretchLastSection = lambda self: getattr(self, "_stretch_last", False)
    sortIndicatorSection = lambda self: -1
    sortIndicatorOrder = lambda self: Qt.SortOrder.AscendingOrder
    height = lambda self: 22
    width = lambda self: 40
    setSectionsMovable = setSectionsClickable = setDragEnabled = setDragDropMode = setDefaultSectionSize = setMinimumSectionSize = \
        setHighlightSections = setDefaultAlignment = setSortIndicator = setSortIndicatorShown = resizeSection = moveSection = setFixedHeight = \
        setFixedWidth = setStyleSheet = setCascadingSectionResizes = setMaximumSectionSize = resizeSections = setFont = setToolTip = \
        setContextMenuPolicy = setSectionsMovable = setMinimumHeight = setObjectName = setDropIndicatorShown = setAcceptDrops = \
        setDragDropOverwriteMode = setFirstSectionMovable = setTextElideMode = lambda self, *a: None
    saveState = lambda self: QtCore.QByteArray(b"")
    restoreState = lambda self, *a: True


class _Table(QAbstractItemView):
    """What QTableView, QTableWidget, QListView and the tree views share: a model shown as an HTML table."""
    _ROW_HEADERS = True
    _MAX_ROWS = 3000

    def __init__(self, parent=None, **k):
        QWidget.__init__(self, parent)
        self._model = None
        self._selmodel = QItemSelectionModel(None)
        self._hh = QHeaderView(self, Qt.Orientation.Horizontal)
        self._vh = QHeaderView(self, Qt.Orientation.Vertical)
        self._behavior = QAbstractItemView.SelectionBehavior.SelectItems
        self._mode = QAbstractItemView.SelectionMode.ExtendedSelection
        self._triggers = QAbstractItemView.EditTrigger.DoubleClicked
        self._table = wx._el("table")
        self._w.el.appendChild(self._table)
        self._w.el.className = "wx-table"
        self._w.el.style.minWidth = "0"
        self._w.el.style.minHeight = "60px"
        self._cells = {}
        self._rows_el = []
        self._hidden_rows = set()
        self._widgets = {}
        self._pending = False
        self._hold = 0

    def _make(self, wxparent):
        return wx.Panel(wxparent)

    # -- model

    def setModel(self, model):
        self._model = model
        self._selmodel = QItemSelectionModel(model)
        if model is not None:
            for name in ("modelReset", "layoutChanged", "rowsInserted", "rowsRemoved", "columnsInserted", "columnsRemoved", "headerDataChanged"):
                getattr(model, name).connect(lambda *a: self._render())
            model.dataChanged.connect(self._data_changed)
        self._render()

    def model(self):
        return self._model

    def selectionModel(self):
        return self._selmodel

    def setSelectionModel(self, sm):
        self._selmodel = sm

    def _nrows(self):
        return self._model.rowCount() if self._model is not None else 0

    def _ncols(self):
        return self._model.columnCount() if self._model is not None else 0

    def _data_changed(self, top=None, bottom=None, roles=None):
        if top is None or bottom is None or not hasattr(top, "row"):
            return self._render()
        if (bottom.row() - top.row() + 1) * (bottom.column() - top.column() + 1) > 200:
            return self._render()
        for r in range(top.row(), bottom.row() + 1):
            for c in range(top.column(), bottom.column() + 1):
                td = self._cells.get((r, c))
                if td is None:
                    return self._render()
                self._fill(td, r, c)

    # -- drawing

    def _clear(self, el):
        try:
            el.textContent = ""
        except Exception:
            pass
        kids = getattr(el, "children", None)
        if isinstance(kids, list):
            del kids[:]

    def _render(self):
        if self._hold:
            self._pending = True
            return
        table = self._table
        self._clear(table)
        self._cells, self._rows_el = {}, []
        m = self._model
        if m is None:
            return
        H = Qt.Orientation.Horizontal
        nrows, ncols = self._nrows(), self._ncols()
        cols = [c for c in range(ncols) if c not in self._hh._hidden]
        if self._hh._shown and ncols:
            tr = wx._el("tr")
            if self._ROW_HEADERS and self._vh._shown:
                tr.appendChild(wx._el("th"))
            for c in cols:
                th = wx._el("th")
                v = m.headerData(c, H, Qt.ItemDataRole.DisplayRole)
                th.textContent = "" if v is None else str(v)
                if self._hh._stretches(c, c == cols[-1]):
                    th.style.width = "100%"
                wx._listen(th, "click", lambda ev=None, c=c: self._hh.sectionClicked.emit(c))
                tr.appendChild(th)
            table.appendChild(tr)
        selected = set(self._selmodel._rows)
        for r in range(min(nrows, self._MAX_ROWS)):
            tr = wx._el("tr")
            if r in selected:
                tr.className = "sel"
            if r in self._hidden_rows:
                tr.style.display = "none"
            if self._ROW_HEADERS and self._vh._shown:
                th = wx._el("th")
                v = m.headerData(r, Qt.Orientation.Vertical, Qt.ItemDataRole.DisplayRole)
                th.textContent = str(r + 1) if v is None else str(v)
                tr.appendChild(th)
            for c in cols:
                td = wx._el("td")
                self._cells[(r, c)] = td
                self._fill(td, r, c)
                wx._listen(td, "click", lambda ev=None, r=r, c=c: self._clicked(r, c, ev))
                wx._listen(td, "dblclick", lambda ev=None, r=r, c=c: self._double(r, c))
                tr.appendChild(td)
            self._rows_el.append(tr)
            table.appendChild(tr)
        if nrows > self._MAX_ROWS:
            tr = wx._el("tr")
            td = wx._el("td")
            td.textContent = f"… {nrows - self._MAX_ROWS} more rows"
            td.colSpan = max(1, len(cols))
            tr.appendChild(td)
            table.appendChild(tr)

    def _fill(self, td, r, c):
        m = self._model
        self._clear(td)
        w = self._widgets.get((r, c))
        if w is not None:
            td.appendChild(w._w.el)
            return
        idx = m.index(r, c)
        try:
            flags = int(m.flags(idx))
        except Exception:
            flags = 33
        check = m.data(idx, Qt.ItemDataRole.CheckStateRole)
        if check is not None:
            box = wx._el("input")
            box.type = "checkbox"
            box.checked = int(check) == 2
            if not flags & 16:
                box.disabled = True
            wx._listen(box, "change", lambda ev=None, r=r, c=c, box=box: self._checked(r, c, box))
            td.appendChild(box)
        v = m.data(idx, Qt.ItemDataRole.DisplayRole)
        if v is not None and str(v) != "":
            span = wx._el("span")
            span.textContent = str(v)
            td.appendChild(span)
        al = m.data(idx, Qt.ItemDataRole.TextAlignmentRole)
        try:
            td.style.textAlign = "center" if al is not None and int(al) & 0x4 else ("right" if al is not None and int(al) & 0x2 else "")
        except Exception:
            pass
        for role, prop in ((Qt.ItemDataRole.ForegroundRole, "color"), (Qt.ItemDataRole.BackgroundRole, "background")):
            col = m.data(idx, role)
            col = col.color() if isinstance(col, QtGui.QBrush) else col
            if isinstance(col, QColor) and col.isValid():
                setattr(td.style, prop, col._css())
        tip = m.data(idx, Qt.ItemDataRole.ToolTipRole)
        if tip:
            td.title = str(tip)

    def _checked(self, r, c, box):
        m = self._model
        state = Qt.CheckState.Checked if box.checked else Qt.CheckState.Unchecked
        if not m.setData(m.index(r, c), state.value, Qt.ItemDataRole.CheckStateRole):
            box.checked = not box.checked

    def _mark(self):
        rows = set(self._selmodel._rows)
        for r, tr in enumerate(self._rows_el):
            tr.className = "sel" if r in rows else ""

    def _clicked(self, r, c, ev=None):
        m = self._model
        idx = m.index(r, c)
        if int(self._mode) != 0:
            multi = int(self._mode) in (2, 3) and ev is not None and (getattr(ev, "ctrlKey", False) or getattr(ev, "metaKey", False))
            if multi:
                rows = list(self._selmodel._rows)
                rows.remove(r) if r in rows else rows.append(r)
            else:
                rows = [r]
            self._selmodel._set_rows(rows, idx)
            self._mark()
            self._selection_changed()
        self.pressed.emit(idx)
        self.clicked.emit(idx)

    def _selection_changed(self):
        pass

    def _double(self, r, c):
        m = self._model
        idx = m.index(r, c)
        self.doubleClicked.emit(idx)
        self.activated.emit(idx)
        try:
            editable = int(m.flags(idx)) & 2
        except Exception:
            editable = False
        if editable and int(self._triggers) & 2:
            self.edit(idx)

    def edit(self, idx, *a):
        """Edit a cell in place: a text field over it, kept on Enter or when it loses focus."""
        td = self._cells.get((idx.row(), idx.column()))
        m = self._model
        if td is None or m is None or not wx._DOM:
            return False
        cur = m.data(idx, Qt.ItemDataRole.EditRole)
        if cur is None:
            cur = m.data(idx, Qt.ItemDataRole.DisplayRole)
        box = wx._el("input")
        box.value = "" if cur is None else str(cur)
        self._clear(td)
        td.appendChild(box)
        done = [False]

        def commit(ev=None):
            if done[0]:
                return
            done[0] = True
            m.setData(idx, str(box.value), Qt.ItemDataRole.EditRole)
            self._fill(td, idx.row(), idx.column())

        def key(ev=None):
            k = getattr(ev, "key", "")
            if k == "Enter":
                commit()
            elif k == "Escape":
                done[0] = True
                self._fill(td, idx.row(), idx.column())

        wx._listen(box, "blur", commit)
        wx._listen(box, "keydown", key)
        try:
            box.focus()
            box.select()
        except Exception:
            pass
        return True

    # -- headers and options

    def horizontalHeader(self):
        return self._hh

    def verticalHeader(self):
        return self._vh

    header = horizontalHeader

    def setSelectionBehavior(self, b):
        self._behavior = b

    def setSelectionMode(self, m):
        self._mode = m

    def setEditTriggers(self, t):
        self._triggers = t

    selectionBehavior = lambda self: self._behavior
    selectionMode = lambda self: self._mode
    editTriggers = lambda self: self._triggers

    def currentIndex(self):
        return self._selmodel.currentIndex()

    def setCurrentIndex(self, idx):
        self._selmodel.setCurrentIndex(idx)
        self._mark()

    def selectedIndexes(self):
        return self._selmodel.selectedIndexes()

    def selectRow(self, r):
        if self._model is not None and 0 <= r < self._nrows():
            self._selmodel._set_rows([r], self._model.index(r, 0))
            self._mark()
            self._selection_changed()

    def selectAll(self):
        self._selmodel._set_rows(list(range(self._nrows())))
        self._mark()
        self._selection_changed()

    def clearSelection(self):
        self._selmodel._set_rows([])
        self._mark()
        self._selection_changed()

    def setRowHidden(self, r, hide, *a):
        (self._hidden_rows.add if hide else self._hidden_rows.discard)(int(r))
        if 0 <= r < len(self._rows_el):
            self._rows_el[r].style.display = "none" if hide else ""

    isRowHidden = lambda self, r, *a: int(r) in self._hidden_rows
    hideRow = lambda self, r: self.setRowHidden(r, True)
    showRow = lambda self, r: self.setRowHidden(r, False)

    def setColumnHidden(self, c, hide):
        self._hh.setSectionHidden(c, hide)

    isColumnHidden = lambda self, c: self._hh.isSectionHidden(c)
    hideColumn = lambda self, c: self.setColumnHidden(c, True)
    showColumn = lambda self, c: self.setColumnHidden(c, False)

    def setIndexWidget(self, idx, w):
        self._widgets[(idx.row(), idx.column())] = w
        if isinstance(w, QWidget):
            QObject.setParent(w, self)
            _wx_reparent(w._w, self._w)
            w._q_visible = True
        td = self._cells.get((idx.row(), idx.column()))
        if td is not None:
            self._fill(td, idx.row(), idx.column())

    indexWidget = lambda self, idx: self._widgets.get((idx.row(), idx.column()))

    def indexAt(self, *a):
        return QModelIndex()

    def scrollToBottom(self):
        try:
            self._w.el.scrollTop = self._w.el.scrollHeight
        except Exception:
            pass

    def scrollToTop(self):
        try:
            self._w.el.scrollTop = 0
        except Exception:
            pass

    def scrollTo(self, idx, *a):
        tr = self._rows_el[idx.row()] if 0 <= idx.row() < len(self._rows_el) else None
        try:
            if tr is not None and wx._DOM:
                tr.scrollIntoView({"block": "nearest"})
        except Exception:
            pass

    def setUpdatesEnabled(self, on):
        self._hold = 0 if on else 1
        if on and self._pending:
            self._pending = False
            self._render()

    def update(self, *a):
        pass

    def reset(self):
        self._render()

    def setSortingEnabled(self, on):
        self._sorting = bool(on)
        if on and not getattr(self, "_sort_hooked", False):
            self._sort_hooked = True
            self._hh.sectionClicked.connect(self._sort_clicked)

    def _sort_clicked(self, col):
        last = getattr(self, "_sort_state", (-1, 1))
        order = 1 - last[1] if last[0] == col else 0
        self._sort_state = (col, order)
        self.sortByColumn(col, order)

    def sortByColumn(self, col, order=0):
        if self._model is not None:
            self._model.sort(col, Qt.SortOrder(int(order)))
            self._render()

    isSortingEnabled = lambda self: getattr(self, "_sorting", False)
    rowHeight = lambda self, r: 22
    columnWidth = lambda self, c: 100
    visualRect = lambda self, idx: QRect(0, 0, 0, 0)
    rowAt = columnAt = lambda self, *a: -1
    setAlternatingRowColors = setShowGrid = setGridStyle = setWordWrap = setCornerButtonEnabled = setColumnWidth = setRowHeight = \
        resizeColumnsToContents = resizeRowsToContents = resizeColumnToContents = resizeRowToContents = setItemDelegate = \
        setItemDelegateForColumn = setItemDelegateForRow = setDragEnabled = setDragDropMode = setDropIndicatorShown = setDefaultDropAction = \
        setDragDropOverwriteMode = setTabKeyNavigation = setIconSize = setTextElideMode = setVerticalScrollMode = setHorizontalScrollMode = \
        setAutoScroll = setSpan = clearSpans = openPersistentEditor = closePersistentEditor = setRootIndex = setUniformRowHeights = \
        setRootIsDecorated = setItemsExpandable = setExpandsOnDoubleClick = setAnimated = setIndentation = setHeaderHidden = expandAll = \
        collapseAll = expand = collapse = setAllColumnsShowFocus = setColumnCount_ = setWrapping = setFlow = setViewMode = setResizeMode = \
        setMovement = setSpacing = setGridSize = setUniformItemSizes = setModelColumn = setBatchSize = setSelectionRectVisible = lambda self, *a: None


class QTableView(_Table):
    pass


class QListView(_Table):
    _ROW_HEADERS = False

    def __init__(self, parent=None, **k):
        _Table.__init__(self, parent)
        self._hh._shown = False

    class ViewMode(enum.IntEnum):
        ListMode = 0
        IconMode = 1

    ListMode, IconMode = ViewMode.ListMode, ViewMode.IconMode


class QTreeView(_Table):
    _ROW_HEADERS = False
    expanded = Signal(object)
    collapsed = Signal(object)


class QColumnView(QTreeView):
    pass


class QTableWidgetItem:
    def __init__(self, *a):
        self._text = next((x for x in a if isinstance(x, str)), "")
        self._data = {}
        self._check = None
        self._flags = Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsEditable
        self._view = None
        self._align = None
        self._fg = self._bg = None
        self._tip = ""

    def _changed(self):
        v = self._view
        if v is not None:
            v._item_changed(self)

    text = lambda self: self._text

    def setText(self, t):
        self._text = _text_of(t)
        self._changed()

    def data(self, role=0x100):
        role = int(role)
        if role in (0, 2):
            return self._text
        if role == 10:
            return self._check
        if role == 7:
            return self._align
        if role == 9:
            return self._fg
        if role == 8:
            return self._bg
        if role == 3:
            return self._tip or None
        return self._data.get(role)

    def setData(self, role, value):
        role = int(role)
        if role in (0, 2):
            self._text = "" if value is None else str(value)
        elif role == 10:
            self._check = Qt.CheckState(int(value))
        else:
            self._data[role] = value
        self._changed()

    def checkState(self):
        return self._check if self._check is not None else Qt.CheckState.Unchecked

    def setCheckState(self, s):
        self._check = Qt.CheckState(int(s))
        self._changed()

    flags = lambda self: self._flags

    def setFlags(self, f):
        self._flags = f
        if int(f) & 16 and self._check is None:
            self._check = Qt.CheckState.Unchecked

    def setTextAlignment(self, a):
        self._align = a

    def setForeground(self, b):
        self._fg = b
        self._changed()

    def setBackground(self, b):
        self._bg = b
        self._changed()

    def setToolTip(self, t):
        self._tip = _text_of(t)

    foreground = lambda self: self._fg
    background = lambda self: self._bg
    toolTip = lambda self: self._tip
    textAlignment = lambda self: self._align or 0
    setIcon = setFont = setSizeHint = setStatusTip = setWhatsThis = lambda self, *a: None
    font = lambda self: QFont()
    icon = lambda self: QIcon()

    def setSelected(self, on):
        v = self._view
        if v is not None:
            r = v._row_of(self)
            if r >= 0:
                rows = list(v._selmodel._rows)
                if on and r not in rows:
                    rows.append(r)
                if not on and r in rows:
                    rows.remove(r)
                v._selmodel._set_rows(rows)
                v._mark()

    def isSelected(self):
        v = self._view
        return v is not None and v._row_of(self) in v._selmodel._rows

    def row(self):
        return self._view._row_of(self) if self._view is not None else -1

    def column(self):
        return self._view._col_of(self) if self._view is not None else -1

    tableWidget = listWidget = lambda self: self._view
    clone = lambda self: QTableWidgetItem(self._text)

    def __lt__(self, other):
        return self._text < other._text


class _ItemModel(QtCore.QAbstractItemModel):
    """The model behind QTableWidget and QListWidget: a grid of items."""

    def __init__(self, view):
        QtCore.QAbstractItemModel.__init__(self)
        self._view = view

    def rowCount(self, parent=None):
        return len(self._view._grid)

    def columnCount(self, parent=None):
        return self._view._cols

    def _item(self, index):
        g = self._view._grid
        r, c = index.row(), index.column()
        return g[r][c] if 0 <= r < len(g) and 0 <= c < len(g[r]) else None

    def data(self, index, role=0):
        it = self._item(index)
        return it.data(role) if it is not None else None

    def setData(self, index, value, role=2):
        it = self._item(index)
        if it is None:
            it = self._view._ITEM()
            self._view._put(index.row(), index.column(), it)
        it.setData(role, value)
        return True

    def flags(self, index):
        it = self._item(index)
        return it.flags() if it is not None else Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsEditable

    def headerData(self, section, orientation, role=0):
        if int(role) != 0:
            return None
        labels = self._view._hlabels if int(orientation) == 1 else self._view._vlabels
        return labels[section] if section < len(labels) and labels[section] is not None else str(section + 1)

    def sort(self, column, order=0):
        g = self._view._grid
        key = lambda row: (row[column]._text if column < len(row) and row[column] is not None else "")

        def natural(row):
            t = key(row)
            try:
                return (0, float(t), "")
            except ValueError:
                return (1, 0.0, t.lower())
        g.sort(key=natural, reverse=bool(int(order)))


class QTableWidget(_Table):
    itemChanged = Signal(object)
    itemClicked = Signal(object)
    itemDoubleClicked = Signal(object)
    itemSelectionChanged = Signal()
    cellClicked = Signal(int, int)
    cellDoubleClicked = Signal(int, int)
    cellChanged = Signal(int, int)
    currentCellChanged = Signal(int, int, int, int)
    currentItemChanged = Signal(object, object)
    itemActivated = Signal(object)
    _ITEM = QTableWidgetItem

    def __init__(self, *a, **k):
        nums = [x for x in a if isinstance(x, int) and not isinstance(x, bool)]
        _Table.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))
        self._grid, self._cols = [], 0
        self._hlabels, self._vlabels = [], []
        self._quiet = 0
        self.setModel(_ItemModel(self))
        self.clicked.connect(self._on_clicked)
        self.doubleClicked.connect(self._on_double)
        if len(nums) >= 2:
            self.setRowCount(nums[0])
            self.setColumnCount(nums[1])

    def _on_clicked(self, idx):
        self.cellClicked.emit(idx.row(), idx.column())
        it = self.item(idx.row(), idx.column())
        if it is not None:
            self.itemClicked.emit(it)

    def _on_double(self, idx):
        self.cellDoubleClicked.emit(idx.row(), idx.column())
        it = self.item(idx.row(), idx.column())
        if it is not None:
            self.itemDoubleClicked.emit(it)
            self.itemActivated.emit(it)

    def _selection_changed(self):
        self.itemSelectionChanged.emit()
        cur = self._selmodel.currentIndex()
        if cur.isValid():
            self.currentCellChanged.emit(cur.row(), cur.column(), -1, -1)
            self.currentItemChanged.emit(self.item(cur.row(), cur.column()), None)

    def _row_of(self, item):
        for r, row in enumerate(self._grid):
            if any(it is item for it in row):
                return r
        return -1

    def _col_of(self, item):
        for row in self._grid:
            for c, it in enumerate(row):
                if it is item:
                    return c
        return -1

    def _item_changed(self, item):
        if self._quiet:
            return
        r, c = self._row_of(item), self._col_of(item)
        if r < 0:
            return
        td = self._cells.get((r, c))
        if td is not None:
            self._fill(td, r, c)
        if not self.signalsBlocked():
            self.itemChanged.emit(item)
            self.cellChanged.emit(r, c)

    def _put(self, r, c, item):
        while len(self._grid) <= r:
            self._grid.append([None] * self._cols)
        row = self._grid[r]
        while len(row) <= c:
            row.append(None)
        self._cols = max(self._cols, c + 1)
        if item is not None:
            item._view = self
        row[c] = item

    def setRowCount(self, n):
        del self._grid[n:]
        while len(self._grid) < n:
            self._grid.append([None] * self._cols)
        self._render()

    def setColumnCount(self, n):
        self._cols = int(n)
        for row in self._grid:
            del row[n:]
            while len(row) < n:
                row.append(None)
        self._render()

    rowCount = lambda self: len(self._grid)
    columnCount = lambda self: self._cols

    def insertRow(self, r):
        r = max(0, min(len(self._grid), r))
        self._grid.insert(r, [None] * self._cols)
        self._widgets = {((rr + 1 if rr >= r else rr), c): w for (rr, c), w in self._widgets.items()}
        self._render()

    def removeRow(self, r):
        if 0 <= r < len(self._grid):
            del self._grid[r]
            self._widgets = {((rr - 1 if rr > r else rr), c): w for (rr, c), w in self._widgets.items() if rr != r}
            self._selmodel._rows = [x - 1 if x > r else x for x in self._selmodel._rows if x != r]
            self._render()

    def insertColumn(self, c):
        self._cols += 1
        for row in self._grid:
            row.insert(c, None)
        self._render()

    def removeColumn(self, c):
        if 0 <= c < self._cols:
            self._cols -= 1
            for row in self._grid:
                if c < len(row):
                    del row[c]
            self._render()

    def setItem(self, r, c, item):
        self._put(r, c, item)
        td = self._cells.get((r, c))
        if td is not None:
            self._fill(td, r, c)
        else:
            self._render()

    def item(self, r, c):
        return self._grid[r][c] if 0 <= r < len(self._grid) and 0 <= c < len(self._grid[r]) else None

    def takeItem(self, r, c):
        it = self.item(r, c)
        if it is not None:
            self._grid[r][c] = None
            it._view = None
            self._render()
        return it

    def itemFromIndex(self, idx):
        return self.item(idx.row(), idx.column())

    def indexFromItem(self, item):
        return self._model.index(self._row_of(item), self._col_of(item))

    def setHorizontalHeaderLabels(self, labels):
        self._hlabels = [_text_of(x) for x in labels]
        self._cols = max(self._cols, len(self._hlabels))
        self._render()

    def setVerticalHeaderLabels(self, labels):
        self._vlabels = [_text_of(x) for x in labels]
        self._render()

    def setHorizontalHeaderItem(self, c, item):
        while len(self._hlabels) <= c:
            self._hlabels.append(None)
        self._hlabels[c] = item.text()
        self._render()

    def horizontalHeaderItem(self, c):
        return QTableWidgetItem(self._hlabels[c]) if c < len(self._hlabels) and self._hlabels[c] is not None else None

    def setVerticalHeaderItem(self, r, item):
        while len(self._vlabels) <= r:
            self._vlabels.append(None)
        self._vlabels[r] = item.text()

    def setCellWidget(self, r, c, w):
        self._put(r, c, self.item(r, c))
        self._widgets[(r, c)] = w
        if isinstance(w, QWidget):
            QObject.setParent(w, self)
            _wx_reparent(w._w, self._w)
            w._q_visible = True
        td = self._cells.get((r, c))
        if td is not None:
            self._fill(td, r, c)
        else:
            self._render()

    def cellWidget(self, r, c):
        return self._widgets.get((r, c))

    def removeCellWidget(self, r, c):
        if self._widgets.pop((r, c), None) is not None:
            self._render()

    def clearContents(self):
        for row in self._grid:
            for c in range(len(row)):
                row[c] = None
        self._widgets = {}
        self._render()

    def clear(self):
        self._hlabels, self._vlabels = [], []
        self.clearContents()

    def currentRow(self):
        cur = self._selmodel.currentIndex()
        return cur.row() if cur.isValid() and cur.row() < len(self._grid) else -1

    def currentColumn(self):
        cur = self._selmodel.currentIndex()
        return cur.column() if cur.isValid() else -1

    def currentItem(self):
        return self.item(self.currentRow(), max(0, self.currentColumn()))

    def setCurrentCell(self, r, c, *a):
        if 0 <= r < len(self._grid):
            self._selmodel._set_rows([r], self._model.index(r, max(0, c)))
            self._mark()
            self._selection_changed()

    def setCurrentItem(self, item, *a):
        if item is not None:
            self.setCurrentCell(self._row_of(item), self._col_of(item))

    def selectedItems(self):
        out = []
        for r in self._selmodel._rows:
            if 0 <= r < len(self._grid):
                out.extend(it for it in self._grid[r] if it is not None)
        return out

    def selectedRanges(self):
        return []

    def findItems(self, text, flags=None):
        out = []
        for row in self._grid:
            for it in row:
                if it is not None and (it._text == text or (flags is not None and int(flags) & 1 and text in it._text)):
                    out.append(it)
        return out

    def sortItems(self, column, order=0):
        self.sortByColumn(column, order)

    def row(self, item):
        return self._row_of(item)

    def column(self, item):
        return self._col_of(item)

    def editItem(self, item):
        self.edit(self.indexFromItem(item))

    visualRow = visualColumn = lambda self, i: i
    setItemPrototype = setRangeSelected = openPersistentEditor = lambda self, *a: None


class QListWidgetItem(QTableWidgetItem):
    def __init__(self, *a):
        QTableWidgetItem.__init__(self, *[x for x in a if isinstance(x, str)])
        self._flags = Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEnabled
        owner = next((x for x in a if isinstance(x, QListWidget)), None)
        if owner is not None:
            owner.addItem(self)

    def data(self, role=0x100):
        return QTableWidgetItem.data(self, role)

    def setHidden(self, hide):
        self._hidden = bool(hide)
        v = self._view
        if v is not None:
            v.setRowHidden(v._row_of(self), hide)

    isHidden = lambda self: getattr(self, "_hidden", False)


class QListWidget(QTableWidget):
    currentRowChanged = Signal(int)
    currentTextChanged = Signal(str)
    itemPressed = Signal(object)
    _ROW_HEADERS = False
    _ITEM = QListWidgetItem

    def __init__(self, parent=None, **k):
        QTableWidget.__init__(self, parent)
        self._cols = 1
        self._hh._shown = False
        self._triggers = QAbstractItemView.EditTrigger.NoEditTriggers

    def _selection_changed(self):
        QTableWidget._selection_changed(self)
        r = self.currentRow()
        self.currentRowChanged.emit(r)
        it = self.item(r)
        self.currentTextChanged.emit(it.text() if it is not None else "")

    def addItem(self, item):
        self.insertItem(len(self._grid), item)

    def insertItem(self, r, item):
        if not isinstance(item, QTableWidgetItem):
            item = QListWidgetItem(_text_of(item))
        r = max(0, min(len(self._grid), r))
        item._view = self
        self._grid.insert(r, [item])
        self._render()

    def addItems(self, texts):
        self._hold += 1
        for t in texts:
            self.addItem(t)
        self._hold -= 1
        self._render()

    insertItems = lambda self, r, texts: [self.insertItem(r + i, t) for i, t in enumerate(texts)] and None

    def item(self, r, c=0):
        return QTableWidget.item(self, r, 0)

    def takeItem(self, r, c=0):
        it = self.item(r)
        if it is not None:
            del self._grid[r]
            it._view = None
            self._selmodel._rows = [x - 1 if x > r else x for x in self._selmodel._rows if x != r]
            self._render()
        return it

    def clear(self):
        self._grid = []
        self._widgets = {}
        self._selmodel._rows = []
        self._selmodel._current = QModelIndex()
        self._render()

    count = lambda self: len(self._grid)

    def setCurrentRow(self, r, *a):
        if r < 0:
            self.clearSelection()
        else:
            self.setCurrentCell(r, 0)

    def row(self, item):
        return self._row_of(item)

    def setItemWidget(self, item, w):
        self.setCellWidget(self._row_of(item), 0, w)

    itemWidget = lambda self, item: self.cellWidget(self._row_of(item), 0)

    def scrollToItem(self, item, *a):
        r = self._row_of(item)
        if r >= 0:
            self.scrollTo(self._model.index(r, 0))

    def sortItems(self, order=0):
        self.sortByColumn(0, order)


class QTreeWidgetItem(QTableWidgetItem):
    def __init__(self, *a):
        texts = next((x for x in a if isinstance(x, (list, tuple))), None)
        QTableWidgetItem.__init__(self)
        self._texts = [_text_of(t) for t in texts] if texts else []
        self._kids = []
        self._up = None
        self._flags = Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEnabled
        self._checks = {}
        self._open = True
        owner = a[0] if a else None
        if isinstance(owner, QTreeWidget):
            owner.addTopLevelItem(self)
        elif isinstance(owner, QTreeWidgetItem):
            owner.addChild(self)

    def text(self, col=0):
        return self._texts[col] if col < len(self._texts) else ""

    def setText(self, col, text):
        while len(self._texts) <= col:
            self._texts.append("")
        self._texts[col] = _text_of(text)
        self._refresh()

    def _refresh(self):
        tree = self.treeWidget()
        if tree is not None:
            tree._rebuild()

    def data(self, col, role=0x100):
        if int(role) in (0, 2):
            return self.text(col)
        if int(role) == 10:
            return self._checks.get(col)
        return self._data.get((col, int(role)))

    def setData(self, col, role, value):
        if int(role) in (0, 2):
            self.setText(col, value)
        elif int(role) == 10:
            self._checks[col] = Qt.CheckState(int(value))
            self._refresh()
        else:
            self._data[(col, int(role))] = value

    def checkState(self, col=0):
        return self._checks.get(col, Qt.CheckState.Unchecked)

    def setCheckState(self, col, state):
        self._checks[col] = Qt.CheckState(int(state))
        self._refresh()

    def addChild(self, item):
        item._up = self
        self._kids.append(item)
        self._refresh()

    def addChildren(self, items):
        for it in items:
            it._up = self
            self._kids.append(it)
        self._refresh()

    def insertChild(self, i, item):
        item._up = self
        self._kids.insert(i, item)
        self._refresh()

    def removeChild(self, item):
        if item in self._kids:
            self._kids.remove(item)
            item._up = None
            self._refresh()

    def takeChild(self, i):
        it = self._kids.pop(i) if 0 <= i < len(self._kids) else None
        if it is not None:
            it._up = None
            self._refresh()
        return it

    def takeChildren(self):
        out, self._kids = self._kids, []
        self._refresh()
        return out

    child = lambda self, i: self._kids[i] if 0 <= i < len(self._kids) else None
    childCount = lambda self: len(self._kids)
    indexOfChild = lambda self, it: self._kids.index(it) if it in self._kids else -1
    parent = lambda self: self._up
    columnCount = lambda self: len(self._texts)

    def treeWidget(self):
        it = self
        while it._up is not None:
            it = it._up
        return it._view

    def setExpanded(self, on):
        self._open = bool(on)
        self._refresh()

    isExpanded = lambda self: self._open
    setFirstColumnSpanned = setChildIndicatorPolicy = lambda self, *a: None

    def setForeground(self, col, brush):
        self._data[(col, 9)] = brush

    def setBackground(self, col, brush):
        self._data[(col, 8)] = brush

    def setToolTip(self, col, tip):
        self._data[(col, 3)] = _text_of(tip)

    setIcon = setFont = setTextAlignment = setSizeHint = lambda self, *a: None


class _TreeModel(QtCore.QAbstractItemModel):
    def __init__(self, view):
        QtCore.QAbstractItemModel.__init__(self)
        self._view = view

    def rowCount(self, parent=None):
        return len(self._view._flat)

    def columnCount(self, parent=None):
        return self._view._ncol

    def data(self, index, role=0):
        r, c = index.row(), index.column()
        if not 0 <= r < len(self._view._flat):
            return None
        item, depth = self._view._flat[r]
        role = int(role)
        if role in (0, 2):
            t = item.text(c)
            if c == 0:
                mark = ("▾ " if item._open else "▸ ") if item._kids else ""
                return " " * (depth * 4) + mark + t
            return t
        if role == 10:
            return item._checks.get(c)
        return item._data.get((c, role))

    def setData(self, index, value, role=2):
        r = index.row()
        if 0 <= r < len(self._view._flat):
            item = self._view._flat[r][0]
            if int(role) == 10:
                item._checks[index.column()] = Qt.CheckState(int(value))
                self._view.itemChanged.emit(item, index.column())
                return True
        return False

    def flags(self, index):
        r = index.row()
        return self._view._flat[r][0].flags() | Qt.ItemFlag.ItemIsUserCheckable if 0 <= r < len(self._view._flat) else Qt.ItemFlag.NoItemFlags

    def headerData(self, section, orientation, role=0):
        if int(role) == 0 and int(orientation) == 1:
            return self._view._hlabels[section] if section < len(self._view._hlabels) else ""
        return None


class QTreeWidget(_Table):
    itemClicked = Signal(object, int)
    itemDoubleClicked = Signal(object, int)
    itemChanged = Signal(object, int)
    itemSelectionChanged = Signal()
    currentItemChanged = Signal(object, object)
    itemExpanded = Signal(object)
    itemCollapsed = Signal(object)
    itemActivated = Signal(object, int)
    _ROW_HEADERS = False

    def __init__(self, parent=None, **k):
        _Table.__init__(self, parent)
        self._tops, self._flat, self._hlabels, self._ncol = [], [], [], 1
        self._triggers = QAbstractItemView.EditTrigger.NoEditTriggers
        self.setModel(_TreeModel(self))
        self.clicked.connect(self._on_clicked)
        self.doubleClicked.connect(lambda idx: self._emit_item(self.itemDoubleClicked, idx))

    def _emit_item(self, sig, idx):
        if 0 <= idx.row() < len(self._flat):
            sig.emit(self._flat[idx.row()][0], idx.column())

    def _on_clicked(self, idx):
        if not 0 <= idx.row() < len(self._flat):
            return
        item = self._flat[idx.row()][0]
        if idx.column() == 0 and item._kids:
            item._open = not item._open
            self._rebuild()
            (self.itemExpanded if item._open else self.itemCollapsed).emit(item)
        self.itemClicked.emit(item, idx.column())

    def _selection_changed(self):
        self.itemSelectionChanged.emit()
        self.currentItemChanged.emit(self.currentItem(), None)

    def _rebuild(self):
        flat = []

        def walk(item, depth):
            flat.append((item, depth))
            if item._open:
                for k in item._kids:
                    walk(k, depth + 1)
        for t in self._tops:
            walk(t, 0)
        self._flat = flat
        self._render()

    def setColumnCount(self, n):
        self._ncol = int(n)
        self._render()

    columnCount = lambda self: self._ncol

    def setHeaderLabels(self, labels):
        self._hlabels = [_text_of(x) for x in labels]
        self._ncol = max(self._ncol, len(self._hlabels))
        self._render()

    def setHeaderLabel(self, label):
        self.setHeaderLabels([label])

    def setHeaderHidden(self, hide):
        self._hh.setVisible(not hide)

    def headerItem(self):
        it = QTreeWidgetItem(self._hlabels)
        return it

    def addTopLevelItem(self, item):
        item._view = self
        self._tops.append(item)
        self._rebuild()

    def addTopLevelItems(self, items):
        for it in items:
            it._view = self
            self._tops.append(it)
        self._rebuild()

    def insertTopLevelItem(self, i, item):
        item._view = self
        self._tops.insert(i, item)
        self._rebuild()

    def takeTopLevelItem(self, i):
        it = self._tops.pop(i) if 0 <= i < len(self._tops) else None
        if it is not None:
            it._view = None
            self._rebuild()
        return it

    topLevelItem = lambda self, i: self._tops[i] if 0 <= i < len(self._tops) else None
    topLevelItemCount = lambda self: len(self._tops)
    indexOfTopLevelItem = lambda self, it: self._tops.index(it) if it in self._tops else -1
    invisibleRootItem = lambda self: _TreeRoot(self)

    def clear(self):
        self._tops = []
        self._selmodel._rows = []
        self._rebuild()

    def currentItem(self):
        cur = self._selmodel.currentIndex()
        return self._flat[cur.row()][0] if cur.isValid() and cur.row() < len(self._flat) else None

    def setCurrentItem(self, item, *a):
        for r, (it, _) in enumerate(self._flat):
            if it is item:
                self.selectRow(r)
                return

    def selectedItems(self):
        return [self._flat[r][0] for r in self._selmodel._rows if 0 <= r < len(self._flat)]

    def expandAll(self):
        def walk(it):
            it._open = True
            for k in it._kids:
                walk(k)
        for t in self._tops:
            walk(t)
        self._rebuild()

    def collapseAll(self):
        for t in self._tops:
            t._open = False
        self._rebuild()

    expandItem = lambda self, it: it.setExpanded(True)
    collapseItem = lambda self, it: it.setExpanded(False)

    def findItems(self, text, flags=None, column=0):
        out = []

        def walk(it):
            if it.text(column) == text:
                out.append(it)
            for k in it._kids:
                walk(k)
        for t in self._tops:
            walk(t)
        return out

    def scrollToItem(self, item, *a):
        pass

    setItemWidget = sortItems = lambda self, *a: None


class _TreeRoot:
    def __init__(self, tree):
        self._t = tree

    addChild = lambda self, it: self._t.addTopLevelItem(it)
    childCount = lambda self: len(self._t._tops)
    child = lambda self, i: self._t.topLevelItem(i)
    takeChild = lambda self, i: self._t.takeTopLevelItem(i)
    takeChildren = lambda self: [self._t.takeTopLevelItem(0) for _ in range(len(self._t._tops))]
    removeChild = lambda self, it: self._t.takeTopLevelItem(self._t.indexOfTopLevelItem(it))


class QStyledItemDelegate(QObject):
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


QItemDelegate = QAbstractItemDelegate = QStyledItemDelegate


class QStyleOptionViewItem:
    def __init__(self, *a):
        self.rect = QRect(0, 0, 0, 0)
        self.palette = QPalette()
        self.font = QFont()
        self.state = 0
        self.text = ""


QStyleOption = QStyleOptionButton = QStyleOptionSlider = QStyleOptionComboBox = QStyleOptionFrame = QStyleOptionHeader = \
    QStyleOptionTab = QStyleOptionProgressBar = QStyleOptionGraphicsItem = QStyleOptionViewItem


# ----------------------------------------------------------------------------- windows

class QStatusBar(QWidget):
    messageChanged = Signal(str)

    def _make(self, wxparent):
        return wx.StatusBar(wxparent)

    def showMessage(self, text, timeout=0):
        self._msg = _text_of(text)
        self._w.SetStatusText(self._msg)
        self.messageChanged.emit(self._msg)
        if timeout and wx._DOM:
            msg = self._msg
            QTimer.singleShot(int(timeout), lambda: self.clearMessage() if self._msg == msg else None)

    def clearMessage(self):
        self._msg = ""
        self._w.SetStatusText("")
        self.messageChanged.emit("")

    currentMessage = lambda self: getattr(self, "_msg", "")

    def addWidget(self, w, stretch=0):
        QObject.setParent(w, self)
        _wx_reparent(w._w, self._w)
        self._w.el.appendChild(w._w.el)
        w._q_visible = True

    addPermanentWidget = insertWidget = insertPermanentWidget = addWidget

    def removeWidget(self, w):
        w._detach()

    setSizeGripEnabled = lambda self, *a: None


class QMenu(QWidget):
    triggered = Signal(object)
    aboutToShow = Signal()
    aboutToHide = Signal()

    def __init__(self, *a, **k):
        title = next((x for x in a if isinstance(x, str)), "")
        parent = next((x for x in a if isinstance(x, QWidget)), None)
        QObject.__init__(self, parent)
        self._q_layout = None
        self._q_title = title
        self._q_actions = []
        self._q_policy = None
        self._q_visible = None
        self._q_frame = None
        self._q_attrs = set()
        self._menu = wx.Menu()
        self._w = None
        self._ids = {}
        self._menu.Bind(wx.EVT_MENU, self._wx_menu)

    def _wx_menu(self, event=None):
        act = self._ids.get(event.GetId() if event is not None else None)
        if act is not None:
            act.trigger()
            self.triggered.emit(act)

    def title(self):
        return self._q_title

    def setTitle(self, t):
        self._q_title = _text_of(t)

    def _action_added(self, act):
        if act.isSeparator():
            self._menu.AppendSeparator()
            return
        if act.menu() is not None:
            self._menu.AppendSubMenu(act.menu()._menu, act.text().replace("&", ""))
            return
        i = wx.NewId()
        kind = wx.ITEM_CHECK if act.isCheckable() else wx.ITEM_NORMAL
        item = self._menu.Append(i, act.text().replace("&", "") or " ", "", kind)
        self._ids[i] = act
        act._q_item = (self._menu, i, item)
        act._q_hooks.append(self._sync)
        self._sync(act)

    def _sync(self, act):
        menu, i, item = getattr(act, "_q_item", (None, None, None))
        if menu is None:
            return
        try:
            menu.Enable(i, act.isEnabled())
            menu.SetLabel(i, act.text().replace("&", "") or " ")
            if act.isCheckable():
                menu.Check(i, act.isChecked())
        except Exception:
            pass

    def addAction(self, *a):
        if a and isinstance(a[0], QAction):
            act = a[0]
        else:
            act = QAction(*[x for x in a if isinstance(x, (str, QIcon))], self)
            fn = next((x for x in a if callable(x) and not isinstance(x, (QObject, str, QIcon))), None)
            if fn is not None:
                act.triggered.connect(fn)
        self._q_actions.append(act)
        self._action_added(act)
        return act

    def addSeparator(self):
        act = QAction(self)
        act.setSeparator(True)
        self._q_actions.append(act)
        self._menu.AppendSeparator()
        return act

    def addSection(self, *a):
        return self.addSeparator()

    def addMenu(self, *a):
        sub = a[0] if a and isinstance(a[0], QMenu) else QMenu(*[x for x in a if isinstance(x, str)], self)
        self._menu.AppendSubMenu(sub._menu, sub.title().replace("&", ""))
        return sub if not (a and isinstance(a[0], QMenu)) else sub.menuAction()

    def menuAction(self):
        act = getattr(self, "_q_menu_action", None)
        if act is None:
            act = self._q_menu_action = QAction(self._q_title, self)
            act._menu = self
        return act

    def clear(self):
        for act in list(self._q_actions):
            item = getattr(act, "_q_item", None)
            if item is not None:
                try:
                    item[0].Delete(item[1])
                except Exception:
                    pass
        self._q_actions, self._ids = [], {}
        self._menu = wx.Menu()
        self._menu.Bind(wx.EVT_MENU, self._wx_menu)

    def isEmpty(self):
        return not self._q_actions

    def exec(self, *a):
        """Show the menu and wait for a choice."""
        self.aboutToShow.emit()
        owner = self._q_parent
        while owner is not None and (not isinstance(owner, QWidget) or owner._w is None):
            owner = owner._q_parent
        host = owner._w if owner is not None else wx.GetApp().GetTopWindow()
        self._picked = None
        hook = self.triggered.connect(lambda act: setattr(self, "_picked", act))
        try:
            host.PopupMenu(self._menu)
        except Exception:
            pass
        self.triggered.disconnect(hook)
        self.aboutToHide.emit()
        return self._picked

    exec_ = popup = exec
    setEnabled = setIcon = setToolTipsVisible = setStyleSheet = setTearOffEnabled = setSeparatorsCollapsible = setDefaultAction = \
        setActiveAction = hide = show = close = setFont = setMinimumWidth = setObjectName_ = lambda self, *a: None
    isEnabled = lambda self: True
    isVisible = lambda self: False


class QMenuBar(QWidget):
    triggered = Signal(object)

    def _make(self, wxparent):
        bar = wx.MenuBar()
        return bar

    def addMenu(self, *a):
        menu = a[0] if a and isinstance(a[0], QMenu) else QMenu(*[x for x in a if isinstance(x, str)], self)
        self._w.Append(menu._menu, menu.title().replace("&", ""))
        if not hasattr(self, "_menus"):
            self._menus = []
        self._menus.append(menu)
        menu.triggered.connect(self.triggered.emit)
        return menu if not (a and isinstance(a[0], QMenu)) else menu.menuAction()

    def addAction(self, *a):
        act = a[0] if a and isinstance(a[0], QAction) else QAction(*[x for x in a if isinstance(x, str)], self)
        if act.menu() is not None:
            self.addMenu(act.menu())
            return act
        menu = QMenu(act.text(), self)
        menu.addAction(act)
        self.addMenu(menu)
        return act

    def clear(self):
        pass

    setNativeMenuBar = setCornerWidget = setDefaultUp = lambda self, *a: None
    isNativeMenuBar = lambda self: False


class QToolBar(QWidget):
    actionTriggered = Signal(object)
    orientationChanged = Signal(object)

    def __init__(self, *a, **k):
        title = next((x for x in a if isinstance(x, str)), "")
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))
        self._q_title = title
        self._box = wx.BoxSizer(wx.HORIZONTAL)
        self._box.el.style.gap = "4px"
        self._box.el.style.flexWrap = "wrap"
        self._w.SetSizer(self._box)

    def _action_added(self, act):
        if act.isSeparator():
            return self._sep()
        b = QToolButton(self)
        b.setDefaultAction(act)
        self._box.Add(b._w, 0, wx.ALIGN_CENTER_VERTICAL)
        act._q_button = b
        b.triggered.connect(self.actionTriggered.emit)

    def _sep(self):
        line = QFrame(self)
        line.setFrameShape(QFrame.Shape.VLine)
        self._box.Add(line._w, 0, wx.EXPAND)

    def addSeparator(self):
        act = QAction(self)
        act.setSeparator(True)
        self._sep()
        return act

    def addWidget(self, w):
        QObject.setParent(w, self)
        _wx_reparent(w._w, self._w)
        self._box.Add(w._w, 0, wx.ALIGN_CENTER_VERTICAL)
        w._q_visible = True
        return QAction(self)

    def widgetForAction(self, act):
        return getattr(act, "_q_button", None)

    def clear(self):
        self._box.Clear(True)
        self._q_actions = []

    setMovable = setFloatable = setIconSize = setToolButtonStyle = setOrientation = setAllowedAreas = lambda self, *a: None
    toggleViewAction = lambda self: QAction(self._q_title, self)
    iconSize = lambda self: QSize(16, 16)
    orientation = lambda self: Qt.Orientation.Horizontal


class _Window(QWidget):
    _TOP = True

    def __init__(self, parent=None, flags=None, **k):
        self._q_wxparent = parent._window_w() if isinstance(parent, QWidget) and parent.isWindow() else None
        QWidget.__init__(self, parent)
        QObject.setParent(self, parent if isinstance(parent, QWidget) else None)

    def _closed(self):
        QWidget._closed(self)
        if self.testAttribute(Qt.WidgetAttribute.WA_DeleteOnClose):
            self.destroyed.emit()

    def destroy(self, *a):
        self.hide()

    def restoreGeometry(self, *a):
        return False

    restoreState = restoreGeometry
    saveGeometry = saveState = lambda self, *a: QtCore.QByteArray(b"")


class QMainWindow(_Window):
    def __init__(self, parent=None, flags=None, **k):
        _Window.__init__(self, parent)
        self._box = wx.BoxSizer(wx.VERTICAL)
        self._w.SetSizer(self._box)
        self._central = self._status = self._menubar = None
        self._bars = []

    def _make(self, wxparent):
        return wx.Frame(None, title="")

    def _rebuild(self):
        box = self._box
        for thing in [self._menubar] + self._bars + [self._central, self._status]:
            if thing is not None:
                try:
                    box.Detach(thing._w)
                except Exception:
                    pass
        if self._menubar is not None:
            box.Add(self._menubar._w, 0, wx.EXPAND)
        for bar in self._bars:
            box.Add(bar._w, 0, wx.EXPAND)
        if self._central is not None:
            box.Add(self._central._w, 1, wx.EXPAND)
        if self._status is not None:
            box.Add(self._status._w, 0, wx.EXPAND)

    def _take(self, w):
        QObject.setParent(w, self)
        _wx_reparent(w._w, self._w)
        w._q_visible = True

    def setCentralWidget(self, w):
        self._central = w
        self._take(w)
        w._w.el.style.overflow = "auto"
        w._w.el.style.minHeight = "0"
        self._rebuild()

    def centralWidget(self):
        return self._central

    takeCentralWidget = lambda self: self._central

    def setStatusBar(self, bar):
        self._status = bar
        if bar is not None:
            self._take(bar)
        self._rebuild()

    def statusBar(self):
        if self._status is None:
            self.setStatusBar(QStatusBar(self))
        return self._status

    def setMenuBar(self, bar):
        self._menubar = bar
        self._take(bar)
        self._rebuild()

    def menuBar(self):
        if self._menubar is None:
            self.setMenuBar(QMenuBar(self))
        return self._menubar

    setMenuWidget = setMenuBar

    def addToolBar(self, *a):
        bar = next((x for x in a if isinstance(x, QToolBar)), None)
        if bar is None:
            bar = QToolBar(next((x for x in a if isinstance(x, str)), ""), self)
        self._bars.append(bar)
        self._take(bar)
        self._rebuild()
        return bar

    def addDockWidget(self, area, dock, *a):
        self._bars.append(dock)
        self._take(dock)
        self._rebuild()

    insertToolBar = lambda self, before, bar: self.addToolBar(bar)
    removeToolBar = removeDockWidget = lambda self, bar: bar.hide()
    setUnifiedTitleAndToolBarOnMac = setDockOptions = setDockNestingEnabled = setTabPosition = setCorner = setIconSize = setToolButtonStyle = \
        setAnimated = setDocumentMode = addToolBarBreak = tabifyDockWidget = splitDockWidget = resizeDocks = lambda self, *a: None
    createPopupMenu = lambda self: None


class QDockWidget(QWidget):
    visibilityChanged = Signal(bool)
    topLevelChanged = Signal(bool)

    def __init__(self, *a, **k):
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))
        self._box = wx.BoxSizer(wx.VERTICAL)
        self._w.SetSizer(self._box)
        self._inner = None

    def setWidget(self, w):
        self._inner = w
        QObject.setParent(w, self)
        _wx_reparent(w._w, self._w)
        self._box.Add(w._w, 1, wx.EXPAND)
        w._q_visible = True

    widget = lambda self: self._inner
    setFeatures = setAllowedAreas = setFloating = setTitleBarWidget = lambda self, *a: None
    toggleViewAction = lambda self: QAction(self._q_title, self)
    isFloating = lambda self: False


class QDialog(_Window):
    accepted = Signal()
    rejected = Signal()
    finished = Signal(int)

    class DialogCode(enum.IntEnum):
        Rejected = 0
        Accepted = 1

    Rejected, Accepted = DialogCode.Rejected, DialogCode.Accepted

    def __init__(self, parent=None, flags=None, **k):
        _Window.__init__(self, parent)
        self._result = 0
        self._in_exec = False

    def _make(self, wxparent):
        return wx.Dialog(None, title="")

    def exec(self):
        self._result = 0
        self._in_exec = True
        wx._call(self.showEvent, QShowEvent())
        try:
            code = self._w.ShowModal()
        finally:
            was, self._in_exec = self._in_exec, False
        if was:                      # ended by the editor (its own buttons or the headless stand-in), not by accept()/reject()
            self._result = 1 if code in (wx.ID_OK, wx.ID_YES) else 0
            self._announce()
        return self._result

    exec_ = exec

    def open(self):
        self.show()

    def _announce(self):
        (self.accepted if self._result == 1 else self.rejected).emit()
        self.finished.emit(self._result)

    def done(self, code):
        self._result = int(code)
        if self._in_exec:
            self._in_exec = False
            self._w.EndModal(wx.ID_OK if self._result == 1 else wx.ID_CANCEL)
        else:
            self.hide()
        self._announce()

    def accept(self):
        self.done(1)

    def reject(self):
        self.done(0)

    def _closed(self):
        if self._in_exec or self.isVisible():
            self.reject()

    def _wx_close(self, event=None):
        ev = QCloseEvent()
        wx._call(self.closeEvent, ev)
        if ev.isAccepted():
            self.reject()

    def result(self):
        return self._result

    def setResult(self, code):
        self._result = int(code)

    def setModal(self, on):
        self._modal = bool(on)

    isModal = lambda self: getattr(self, "_modal", False) or self._in_exec
    setSizeGripEnabled = lambda self, *a: None


class QDialogButtonBox(QWidget):
    accepted = Signal()
    rejected = Signal()
    clicked = Signal(object)
    helpRequested = Signal()

    class StandardButton(enum.IntFlag):
        NoButton = 0
        Ok = 0x400
        Save = 0x800
        SaveAll = 0x1000
        Open = 0x2000
        Yes = 0x4000
        YesToAll = 0x8000
        No = 0x10000
        NoToAll = 0x20000
        Abort = 0x40000
        Retry = 0x80000
        Ignore = 0x100000
        Close = 0x200000
        Cancel = 0x400000
        Discard = 0x800000
        Help = 0x1000000
        Apply = 0x2000000
        Reset = 0x4000000
        RestoreDefaults = 0x8000000

    class ButtonRole(enum.IntEnum):
        InvalidRole = -1
        AcceptRole = 0
        RejectRole = 1
        DestructiveRole = 2
        ActionRole = 3
        HelpRole = 4
        YesRole = 5
        NoRole = 6
        ResetRole = 7
        ApplyRole = 8

    _ACCEPT = (0x400, 0x800, 0x1000, 0x2000, 0x4000, 0x8000, 0x80000, 0x100000)
    _REJECT = (0x10000, 0x20000, 0x40000, 0x200000, 0x400000)
    _NAMES = {0x400: "OK", 0x800: "Save", 0x1000: "Save All", 0x2000: "Open", 0x4000: "Yes", 0x8000: "Yes to All", 0x10000: "No",
              0x20000: "No to All", 0x40000: "Abort", 0x80000: "Retry", 0x100000: "Ignore", 0x200000: "Close", 0x400000: "Cancel",
              0x800000: "Discard", 0x1000000: "Help", 0x2000000: "Apply", 0x4000000: "Reset", 0x8000000: "Restore Defaults"}

    def __init__(self, *a, **k):
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))
        self._box = wx.BoxSizer(wx.HORIZONTAL)
        self._box.el.style.gap = "6px"
        self._box.el.style.justifyContent = "flex-end"
        self._w.SetSizer(self._box)
        self._buttons = []                # (button, role, standard)
        std = next((x for x in a if isinstance(x, QDialogButtonBox.StandardButton)), None)
        if std is not None:
            self.setStandardButtons(std)

    def _role_of(self, std):
        if std in self._ACCEPT:
            return QDialogButtonBox.ButtonRole.AcceptRole
        if std in self._REJECT:
            return QDialogButtonBox.ButtonRole.RejectRole
        return {0x1000000: QDialogButtonBox.ButtonRole.HelpRole, 0x2000000: QDialogButtonBox.ButtonRole.ApplyRole,
                0x800000: QDialogButtonBox.ButtonRole.DestructiveRole}.get(std, QDialogButtonBox.ButtonRole.ResetRole)

    def setStandardButtons(self, buttons):
        for b, _, std in list(self._buttons):
            if std:
                self.removeButton(b)
        for bit in sorted(self._NAMES, key=lambda b: (b in self._ACCEPT, b)):          # the confirming button goes last, as in KiCad
            if int(buttons) & bit:
                self._add(QPushButton(self._NAMES[bit], self), self._role_of(bit), bit)

    def _add(self, b, role, std=0):
        QObject.setParent(b, self)
        _wx_reparent(b._w, self._w)
        self._box.Add(b._w, 0, 0)
        b._q_visible = True
        self._buttons.append((b, role, std))
        b.clicked.connect(lambda *_: self._pressed(b, role))
        if int(role) == 0:
            b.setDefault(True)
        return b

    def _pressed(self, b, role):
        self.clicked.emit(b)
        if int(role) in (0, 5):
            self.accepted.emit()
        elif int(role) in (1, 6):
            self.rejected.emit()
        elif int(role) == 4:
            self.helpRequested.emit()

    def addButton(self, *a):
        if a and isinstance(a[0], QDialogButtonBox.StandardButton):
            return self._add(QPushButton(self._NAMES.get(int(a[0]), "OK"), self), self._role_of(int(a[0])), int(a[0]))
        role = next((x for x in a if isinstance(x, QDialogButtonBox.ButtonRole)), QDialogButtonBox.ButtonRole.ActionRole)
        b = a[0] if a and isinstance(a[0], QAbstractButton) else QPushButton(next((x for x in a if isinstance(x, str)), ""), self)
        self._add(b, role)
        return b if not (a and isinstance(a[0], QAbstractButton)) else None

    def removeButton(self, b):
        for entry in list(self._buttons):
            if entry[0] is b:
                self._buttons.remove(entry)
                try:
                    self._box.Detach(b._w)
                except Exception:
                    pass
                b._detach()

    def button(self, which):
        return next((b for b, _, std in self._buttons if std == int(which)), None)

    def buttons(self):
        return [b for b, _, _ in self._buttons]

    def buttonRole(self, b):
        return next((r for x, r, _ in self._buttons if x is b), QDialogButtonBox.ButtonRole.InvalidRole)

    def standardButton(self, b):
        return QDialogButtonBox.StandardButton(next((s for x, _, s in self._buttons if x is b), 0))

    def standardButtons(self):
        v = 0
        for _, _, s in self._buttons:
            v |= s
        return QDialogButtonBox.StandardButton(v)

    setOrientation = setCenterButtons = lambda self, *a: None


for _group in (QDialogButtonBox.StandardButton, QDialogButtonBox.ButtonRole):
    for _m in _group:
        setattr(QDialogButtonBox, _m.name, _m)


class QMessageBox(QDialog):
    buttonClicked = Signal(object)

    class Icon(enum.IntEnum):
        NoIcon = 0
        Information = 1
        Warning = 2
        Critical = 3
        Question = 4

    StandardButton = QDialogButtonBox.StandardButton
    ButtonRole = QDialogButtonBox.ButtonRole

    def __init__(self, *a, **k):
        QDialog.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))
        strs = [x for x in a if isinstance(x, str)]
        self._q_title = strs[0] if strs else ""
        self._text = strs[1] if len(strs) > 1 else ""
        self._info = self._detail = ""
        self._icon = next((x for x in a if isinstance(x, QMessageBox.Icon)), QMessageBox.Icon.NoIcon)
        self._std = next((x for x in a if isinstance(x, QDialogButtonBox.StandardButton)), QDialogButtonBox.StandardButton.NoButton)
        self._custom = []
        self._clicked = None
        self._default = None

    def setText(self, t):
        self._text = _plain(t) if _rich(t) else _text_of(t)

    def setInformativeText(self, t):
        self._info = _plain(t) if _rich(t) else _text_of(t)

    def setDetailedText(self, t):
        self._detail = _text_of(t)

    def setIcon(self, icon):
        self._icon = icon

    def setStandardButtons(self, b):
        self._std = b

    def setDefaultButton(self, b):
        self._default = b

    def addButton(self, *a):
        if a and isinstance(a[0], QDialogButtonBox.StandardButton):
            self._std = QDialogButtonBox.StandardButton(int(self._std) | int(a[0]))
            b = QPushButton(QDialogButtonBox._NAMES.get(int(a[0]), "OK"))
            b._q_std = int(a[0])
            self._custom.append((b, QDialogButtonBox.ButtonRole.AcceptRole if int(a[0]) in QDialogButtonBox._ACCEPT else QDialogButtonBox.ButtonRole.RejectRole))
            return b
        role = next((x for x in a if isinstance(x, QDialogButtonBox.ButtonRole)), QDialogButtonBox.ButtonRole.ActionRole)
        b = a[0] if a and isinstance(a[0], QAbstractButton) else QPushButton(next((x for x in a if isinstance(x, str)), ""))
        self._custom.append((b, role))
        return b

    text = lambda self: self._text
    informativeText = lambda self: self._info
    detailedText = lambda self: self._detail
    icon = lambda self: self._icon
    standardButtons = lambda self: self._std
    clickedButton = lambda self: self._clicked
    setTextFormat = setWindowModality = setEscapeButton = setCheckBox = setIconPixmap = setTextInteractionFlags = setModal = lambda self, *a: None
    checkBox = lambda self: None
    button = lambda self, which: next((b for b, _ in self._custom if getattr(b, "_q_std", None) == int(which)), None)
    buttons = lambda self: [b for b, _ in self._custom]

    def _message(self):
        return "\n\n".join(t for t in (self._text, self._info, self._detail) if t)

    def exec(self):
        S = QDialogButtonBox.StandardButton
        if self._custom and not any(hasattr(b, "_q_std") for b, _ in self._custom):
            labels = [b.text().replace("&", "") for b, _ in self._custom]
            if len(labels) == 1:
                wx.MessageBox(self._message(), self._q_title or "Message", wx.OK)
                pick = 0
            elif len(labels) == 2:
                # the accepting button answers "yes"
                yes = next((i for i, (_, r) in enumerate(self._custom) if int(r) in (0, 5)), 0)
                no = 1 - yes
                ok = wx._confirm(self._q_title or "Message", self._message(), labels[yes], labels[no]) if (wx._DOM or wx._bridge is not None) else True
                pick = yes if ok else no
            else:
                dlg = wx.SingleChoiceDialog(None, self._message(), self._q_title or "Message", labels)
                pick = dlg.GetSelection() if dlg.ShowModal() == wx.ID_OK else next((i for i, (_, r) in enumerate(self._custom) if int(r) in (1, 6)), len(labels) - 1)
            self._clicked = self._custom[pick][0]
            self.buttonClicked.emit(self._clicked)
            wx._call(self._clicked.clicked.emit, False)
            self._result = pick
            return pick
        code = _message(self._q_title, self._message(), self._std, self._icon)
        self._clicked = next((b for b, _ in self._custom if getattr(b, "_q_std", None) == int(code)), None)
        self._result = int(code)
        if self._clicked is not None:
            self.buttonClicked.emit(self._clicked)
        return code

    exec_ = exec

    def show(self):
        self.exec()

    open = show

    @staticmethod
    def information(parent, title, text, buttons=StandardButton.Ok, default=StandardButton.NoButton):
        return _message(title, text, buttons, QMessageBox.Icon.Information)

    @staticmethod
    def warning(parent, title, text, buttons=StandardButton.Ok, default=StandardButton.NoButton):
        return _message(title, text, buttons, QMessageBox.Icon.Warning)

    @staticmethod
    def critical(parent, title, text, buttons=StandardButton.Ok, default=StandardButton.NoButton):
        return _message(title, text, buttons, QMessageBox.Icon.Critical)

    @staticmethod
    def question(parent, title, text, buttons=StandardButton.Yes | StandardButton.No, default=StandardButton.NoButton):
        return _message(title, text, buttons, QMessageBox.Icon.Question)

    @staticmethod
    def about(parent, title, text):
        _message(title, text, QDialogButtonBox.StandardButton.Ok, QMessageBox.Icon.Information)

    aboutQt = staticmethod(lambda *a: None)


for _m in QMessageBox.Icon:
    setattr(QMessageBox, _m.name, _m)
for _group in (QDialogButtonBox.StandardButton, QDialogButtonBox.ButtonRole):
    for _m in _group:
        setattr(QMessageBox, _m.name, _m)


def _message(title, text, buttons, icon):
    """A message box drawn by the editor; returns the standard button that was pressed."""
    S = QDialogButtonBox.StandardButton
    b = int(buttons or S.Ok)
    text = _plain(text) if _rich(text) else _text_of(text)
    style = {1: wx.ICON_INFORMATION, 2: wx.ICON_WARNING, 3: wx.ICON_ERROR, 4: wx.ICON_QUESTION}.get(int(icon), 0)
    yes = next((s for s in (S.Yes, S.YesToAll, S.Save, S.SaveAll, S.Open, S.Retry, S.Apply) if b & s), None)
    no = next((s for s in (S.No, S.NoToAll, S.Discard) if b & s), None)
    cancel = next((s for s in (S.Cancel, S.Close, S.Abort) if b & s), None)
    ok = next((s for s in (S.Ok, S.Ignore) if b & s), None)
    title = _text_of(title) or "Message"
    if yes is not None and (no is not None or cancel is not None):
        r = wx.MessageBox(text, title, wx.YES_NO | style)
        return yes if r == wx.YES else (no if no is not None else cancel)
    if (ok is not None or yes is not None) and cancel is not None:
        r = wx.MessageBox(text, title, wx.OK | wx.CANCEL | style)
        return (ok if ok is not None else yes) if r == wx.OK else cancel
    wx.MessageBox(text, title, wx.OK | style)
    return ok or yes or cancel or no or S.Ok


def _wildcard(filt):
    """Qt's "Images (*.png *.jpg);;All files (*)" as wx's "Images|*.png;*.jpg|All files|*"."""
    import re
    parts = []
    for one in str(filt or "").split(";;"):
        one = one.strip()
        if not one:
            continue
        m = re.search(r"\(([^)]*)\)", one)
        pats = (m.group(1) if m else one).split()
        parts.append(one)
        parts.append(";".join(pats) or "*")
    return "|".join(parts) if parts else "*.*"


class QFileDialog(QDialog):
    fileSelected = Signal(str)
    filesSelected = Signal(list)

    class AcceptMode(enum.IntEnum):
        AcceptOpen = 0
        AcceptSave = 1

    class FileMode(enum.IntEnum):
        AnyFile = 0
        ExistingFile = 1
        Directory = 2
        ExistingFiles = 3

    class Option(enum.IntFlag):
        ShowDirsOnly = 1
        DontResolveSymlinks = 2
        DontConfirmOverwrite = 4
        DontUseNativeDialog = 16
        ReadOnly = 32
        HideNameFilterDetails = 64
        DontUseCustomDirectoryIcons = 128

    class ViewMode(enum.IntEnum):
        Detail = 0
        List = 1

    class DialogLabel(enum.IntEnum):
        LookIn = 0
        FileName = 1
        FileType = 2
        Accept = 3
        Reject = 4

    Options = Option

    def __init__(self, *a, **k):
        QDialog.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))
        strs = [x for x in a if isinstance(x, str)]
        self._caption = strs[0] if strs else ""
        self._dir = strs[1] if len(strs) > 1 else ""
        self._filter = strs[2] if len(strs) > 2 else ""
        self._mode, self._accept = QFileDialog.FileMode.AnyFile, QFileDialog.AcceptMode.AcceptOpen
        self._files, self._suffix, self._name = [], "", ""

    def setFileMode(self, m):
        self._mode = m

    def setAcceptMode(self, m):
        self._accept = m

    def setNameFilter(self, f):
        self._filter = _text_of(f)

    def setNameFilters(self, fs):
        self._filter = ";;".join(fs)

    def setDirectory(self, d):
        self._dir = _text_of(d)

    def setDefaultSuffix(self, s):
        self._suffix = _text_of(s)

    def selectFile(self, name):
        self._name = _text_of(name)

    def setWindowTitle(self, t):
        self._caption = _text_of(t)

    setOption = setOptions = setViewMode = setLabelText = setMimeTypeFilters = selectNameFilter = setSidebarUrls = setHistory = lambda self, *a: None
    selectedFiles = lambda self: list(self._files)
    selectedNameFilter = lambda self: self._filter.split(";;")[0] if self._filter else ""
    directory = lambda self: QtCore.QDir(self._dir or ".")

    def exec(self):
        if int(self._mode) == 2:
            p = QFileDialog.getExistingDirectory(None, self._caption, self._dir)
            self._files = [p] if p else []
        elif int(self._accept) == 1:
            p, _ = QFileDialog.getSaveFileName(None, self._caption, os.path.join(self._dir, self._name) if self._name else self._dir, self._filter)
            if p and self._suffix and not os.path.splitext(p)[1]:
                p += "." + self._suffix.lstrip(".")
            self._files = [p] if p else []
        elif int(self._mode) == 3:
            self._files, _ = QFileDialog.getOpenFileNames(None, self._caption, self._dir, self._filter)
        else:
            p, _ = QFileDialog.getOpenFileName(None, self._caption, self._dir, self._filter)
            self._files = [p] if p else []
        self._result = 1 if self._files else 0
        if self._files:
            self.fileSelected.emit(self._files[0])
            self.filesSelected.emit(list(self._files))
        self._announce()
        return self._result

    exec_ = exec

    @staticmethod
    def _split(directory):
        d = _text_of(directory)
        if d and not os.path.isdir(d) and os.path.basename(d) and "." in os.path.basename(d):
            return os.path.dirname(d), os.path.basename(d)
        return d, ""

    @staticmethod
    def getOpenFileName(parent=None, caption="", dir="", filter="", selectedFilter="", options=None, **k):
        d, name = QFileDialog._split(k.get("directory", dir))
        dlg = wx.FileDialog(None, caption or "Open", d, name, _wildcard(filter), wx.FD_OPEN | wx.FD_FILE_MUST_EXIST)
        if dlg.ShowModal() != wx.ID_OK:
            return "", ""
        return dlg.GetPath(), (str(filter).split(";;")[0] if filter else "")

    @staticmethod
    def getOpenFileNames(parent=None, caption="", dir="", filter="", selectedFilter="", options=None, **k):
        d, name = QFileDialog._split(k.get("directory", dir))
        dlg = wx.FileDialog(None, caption or "Open", d, name, _wildcard(filter), wx.FD_OPEN | wx.FD_FILE_MUST_EXIST | wx.FD_MULTIPLE)
        if dlg.ShowModal() != wx.ID_OK:
            return [], ""
        return list(dlg.GetPaths()), (str(filter).split(";;")[0] if filter else "")

    @staticmethod
    def getSaveFileName(parent=None, caption="", dir="", filter="", selectedFilter="", options=None, **k):
        d, name = QFileDialog._split(k.get("directory", dir))
        dlg = wx.FileDialog(None, caption or "Save", d, name, _wildcard(filter), wx.FD_SAVE | wx.FD_OVERWRITE_PROMPT)
        if dlg.ShowModal() != wx.ID_OK:
            return "", ""
        return dlg.GetPath(), (str(filter).split(";;")[0] if filter else "")

    @staticmethod
    def getExistingDirectory(parent=None, caption="", dir="", options=None, **k):
        dlg = wx.DirDialog(None, caption or "Choose a folder", _text_of(k.get("directory", dir)))
        if dlg.ShowModal() != wx.ID_OK:
            return ""
        return dlg.GetPath()

    getExistingDirectoryUrl = getExistingDirectory


for _group in (QFileDialog.AcceptMode, QFileDialog.FileMode, QFileDialog.Option, QFileDialog.ViewMode, QFileDialog.DialogLabel):
    for _m in _group:
        setattr(QFileDialog, _m.name, _m)


class QInputDialog(QDialog):
    @staticmethod
    def getText(parent, title, label, echo=None, text="", *a, **k):
        dlg = wx.TextEntryDialog(None, _text_of(label), _text_of(title), _text_of(text))
        if dlg.ShowModal() != wx.ID_OK:
            return "", False
        return dlg.GetValue(), True

    getMultiLineText = getText

    @staticmethod
    def getInt(parent, title, label, value=0, minValue=-2147483647, maxValue=2147483647, step=1, *a, **k):
        s, ok = QInputDialog.getText(parent, title, label, None, str(value))
        try:
            return (max(minValue, min(maxValue, int(float(s)))), True) if ok else (value, False)
        except ValueError:
            return value, False

    @staticmethod
    def getDouble(parent, title, label, value=0.0, minValue=-2147483647, maxValue=2147483647, decimals=1, *a, **k):
        s, ok = QInputDialog.getText(parent, title, label, None, str(value))
        try:
            return (max(minValue, min(maxValue, float(s))), True) if ok else (value, False)
        except ValueError:
            return value, False

    @staticmethod
    def getItem(parent, title, label, items, current=0, editable=True, *a, **k):
        items = [_text_of(i) for i in items]
        dlg = wx.SingleChoiceDialog(None, _text_of(label), _text_of(title), items)
        try:
            dlg.SetSelection(current)
        except Exception:
            pass
        if dlg.ShowModal() != wx.ID_OK:
            return (items[current] if 0 <= current < len(items) else ""), False
        return dlg.GetStringSelection(), True


class QColorDialog(QDialog):
    class ColorDialogOption(enum.IntFlag):
        ShowAlphaChannel = 1
        NoButtons = 2
        DontUseNativeDialog = 4

    ShowAlphaChannel, NoButtons, DontUseNativeDialog = ColorDialogOption.ShowAlphaChannel, ColorDialogOption.NoButtons, ColorDialogOption.DontUseNativeDialog

    @staticmethod
    def getColor(initial=None, parent=None, title="", *a, **k):
        start = initial.name() if isinstance(initial, QColor) and initial.isValid() else "#ffffff"
        s, ok = QInputDialog.getText(parent, title or "Select Color", "Colour (#rrggbb):", None, start)
        return QColor(s) if ok and QColor(s).isValid() else QColor()


class QFontDialog(QDialog):
    @staticmethod
    def getFont(*a, **k):
        return False, QFont()


class QProgressDialog(QDialog):
    canceled = Signal()

    def __init__(self, *a, **k):
        QDialog.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))
        strs = [x for x in a if isinstance(x, str)]
        nums = [x for x in a if isinstance(x, int) and not isinstance(x, bool)]
        self._label = strs[0] if strs else ""
        self._lo, self._hi = (nums[0], nums[1]) if len(nums) >= 2 else (0, 100)
        self._v = 0
        self._dlg = None
        self._cancelled = False

    def _open(self):
        if self._dlg is None:
            self._dlg = wx.ProgressDialog(self._q_title or "Working", self._label, max(1, self._hi - self._lo), style=wx.PD_CAN_ABORT | wx.PD_APP_MODAL)

    def setValue(self, v):
        self._v = int(v)
        self._open()
        if self._v >= self._hi:
            self.close()
            return
        try:
            r = self._dlg.Update(max(0, self._v - self._lo), self._label)
            keep = r[0] if isinstance(r, tuple) else r
            if not keep and not self._cancelled:
                self._cancelled = True
                self.canceled.emit()
        except Exception:
            pass

    def setLabelText(self, t):
        self._label = _text_of(t)
        if self._dlg is not None:
            try:
                self._dlg.Update(max(0, self._v - self._lo), self._label)
            except Exception:
                pass

    def setRange(self, lo, hi):
        self._lo, self._hi = int(lo), int(hi)

    setMaximum = lambda self, hi: self.setRange(self._lo, hi)
    setMinimum = lambda self, lo: self.setRange(lo, self._hi)

    def wasCanceled(self):
        return self._cancelled

    def cancel(self):
        self._cancelled = True
        self.close()

    def show(self):
        self._open()

    def close(self):
        if self._dlg is not None:
            try:
                self._dlg.Destroy()
            except Exception:
                pass
            self._dlg = None
        return True

    hide = reset = close
    value = lambda self: self._v
    maximum = lambda self: self._hi
    minimum = lambda self: self._lo
    setCancelButton = setCancelButtonText = setMinimumDuration = setAutoClose = setAutoReset = setBar = setLabel = lambda self, *a: None


class QErrorMessage(QDialog):
    def showMessage(self, text, *a):
        _message("Error", text, QDialogButtonBox.StandardButton.Ok, QMessageBox.Icon.Critical)


class QWizard(QDialog):
    pass


class QWizardPage(QWidget):
    pass


# ----------------------------------------------------------------------------- application, style and odds

class QStyle(QObject):
    class StandardPixmap(enum.IntEnum):
        SP_TitleBarMenuButton = 0
        SP_MessageBoxInformation = 9
        SP_MessageBoxWarning = 10
        SP_MessageBoxCritical = 11
        SP_MessageBoxQuestion = 12
        SP_DesktopIcon = 13
        SP_DirOpenIcon = 19
        SP_DirClosedIcon = 20
        SP_DirIcon = 37
        SP_FileIcon = 25
        SP_DialogOkButton = 38
        SP_DialogCancelButton = 39
        SP_DialogHelpButton = 40
        SP_DialogOpenButton = 41
        SP_DialogSaveButton = 42
        SP_DialogCloseButton = 43
        SP_DialogApplyButton = 44
        SP_DialogResetButton = 45
        SP_DialogDiscardButton = 46
        SP_ArrowUp = 50
        SP_ArrowDown = 51
        SP_ArrowLeft = 52
        SP_ArrowRight = 53
        SP_ArrowBack = 54
        SP_ArrowForward = 55
        SP_BrowserReload = 59
        SP_BrowserStop = 60
        SP_MediaPlay = 61
        SP_MediaStop = 62
        SP_MediaPause = 63
        SP_TrashIcon = 40001
        SP_FileDialogDetailedView = 34
        SP_ComputerIcon = 14

    class PixelMetric(enum.IntEnum):
        PM_ScrollBarExtent = 9
        PM_LayoutLeftMargin = 75
        PM_LayoutTopMargin = 76
        PM_LayoutRightMargin = 77
        PM_LayoutBottomMargin = 78
        PM_LayoutHorizontalSpacing = 79
        PM_LayoutVerticalSpacing = 80
        PM_SmallIconSize = 62
        PM_ButtonIconSize = 71
        PM_DefaultFrameWidth = 5

    class StateFlag(enum.IntFlag):
        State_None = 0
        State_Enabled = 1
        State_Selected = 0x8000
        State_MouseOver = 0x2000
        State_HasFocus = 0x100

    def standardIcon(self, *a):
        return QIcon()

    def standardPixmap(self, *a):
        return QPixmap()

    def pixelMetric(self, metric, *a):
        return {9: 14, 75: 9, 76: 9, 77: 9, 78: 9, 79: 6, 80: 6, 62: 16, 71: 16, 5: 1}.get(int(metric), 0)

    def polish(self, *a):
        pass

    unpolish = drawControl = drawPrimitive = drawComplexControl = drawItemText = lambda self, *a: None
    styleHint = lambda self, *a: 0
    objectName = lambda self: "kicad-web"
    name = lambda self: "kicad-web"
    standardPalette = lambda self: QPalette()
    sizeFromContents = lambda self, kind, opt, size, *a: size
    subElementRect = subControlRect = lambda self, *a: QRect(0, 0, 0, 0)


for _group in (QStyle.StandardPixmap, QStyle.PixelMetric, QStyle.StateFlag):
    for _m in _group:
        setattr(QStyle, _m.name, _m)
QProxyStyle = QCommonStyle = QStyle


class QStyleFactory:
    @staticmethod
    def keys():
        return ["kicad-web", "Fusion"]

    @staticmethod
    def create(name):
        return QStyle()


class QApplication(QCoreApplication):
    focusChanged = Signal(object, object)
    lastWindowClosed = Signal()
    _style = None

    def __init__(self, argv=None):
        QCoreApplication.__init__(self, argv)

    @staticmethod
    def style():
        if QApplication._style is None:
            QApplication._style = QStyle()
        return QApplication._style

    @staticmethod
    def setStyle(*a):
        return QApplication.style()

    @staticmethod
    def activeWindow():
        for w in reversed(wx.GetTopLevelWindows()):
            if getattr(w, "_wx_visible", False) and getattr(w, "_q_owner", None) is not None:
                return w._q_owner
        return None

    activeModalWidget = activePopupWidget = focusWidget = staticmethod(lambda: None)

    @staticmethod
    def topLevelWidgets():
        return [w._q_owner for w in wx.GetTopLevelWindows() if getattr(w, "_q_owner", None) is not None]

    allWidgets = topLevelWidgets

    @staticmethod
    def closeAllWindows():
        for w in QApplication.topLevelWidgets():
            w.close()

    @staticmethod
    def beep():
        pass

    @staticmethod
    def widgetAt(*a):
        return None

    setStyleSheet = setWindowIcon = setPalette = setFont = setQuitOnLastWindowClosed = setOverrideCursor = restoreOverrideCursor = \
        setDesktopFileName = setApplicationDisplayName = setHighDpiScaleFactorRoundingPolicy = setEffectEnabled = setLayoutDirection = \
        setDoubleClickInterval = setCursorFlashTime = alert = setActiveWindow = staticmethod(lambda *a, **k: None)
    styleSheet = staticmethod(lambda: "")
    palette = staticmethod(lambda *a: QPalette())
    font = staticmethod(lambda *a: QFont())
    clipboard = staticmethod(QGuiApplication.clipboard)
    primaryScreen = staticmethod(QGuiApplication.primaryScreen)
    screens = staticmethod(QGuiApplication.screens)
    screenAt = staticmethod(QGuiApplication.screenAt)
    styleHints = staticmethod(QGuiApplication.styleHints)
    keyboardModifiers = queryKeyboardModifiers = staticmethod(QGuiApplication.keyboardModifiers)
    mouseButtons = staticmethod(QGuiApplication.mouseButtons)
    overrideCursor = staticmethod(lambda: None)
    platformName = staticmethod(lambda: "web")
    desktop = staticmethod(lambda: QtGui.QScreen())
    devicePixelRatio = staticmethod(lambda *a: 1.0)
    windowIcon = staticmethod(lambda: QIcon())
    quitOnLastWindowClosed = staticmethod(lambda: True)
    doubleClickInterval = staticmethod(lambda: 400)


qApp = None


class QToolTip:
    @staticmethod
    def showText(pos, text, *a):
        pass

    hideText = setFont = setPalette = staticmethod(lambda *a: None)
    isVisible = staticmethod(lambda: False)
    text = staticmethod(lambda: "")
    font = staticmethod(lambda: QFont())
    palette = staticmethod(lambda: QPalette())


class QWhatsThis:
    enterWhatsThisMode = leaveWhatsThisMode = showText = hideText = staticmethod(lambda *a: None)


class QCompleter(QObject):
    activated = Signal(str)

    def __init__(self, *a):
        QObject.__init__(self, next((x for x in a if isinstance(x, QObject)), None))

    setCaseSensitivity = setFilterMode = setCompletionMode = setModel = setCompletionColumn = setMaxVisibleItems = setWidget = \
        setCompletionPrefix = complete = lambda self, *a: None
    popup = lambda self: None


class QSystemTrayIcon(QObject):
    activated = Signal(object)
    isSystemTrayAvailable = staticmethod(lambda: False)
    show = hide = setIcon = setToolTip = setContextMenu = showMessage = lambda self, *a: None


class QGraphicsEffect(QObject):
    def __init__(self, *a):
        QObject.__init__(self, next((x for x in a if isinstance(x, QObject)), None))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


QGraphicsDropShadowEffect = QGraphicsOpacityEffect = QGraphicsBlurEffect = QGraphicsColorizeEffect = QGraphicsEffect


class QRubberBand(QWidget):
    class Shape(enum.IntEnum):
        Line = 0
        Rectangle = 1

    Line, Rectangle = Shape.Line, Shape.Rectangle

    def __init__(self, *a):
        QWidget.__init__(self, next((x for x in a if isinstance(x, QWidget)), None))


class QSizeGrip(QWidget):
    pass


class QCalendarWidget(QWidget):
    pass


class QLCDNumber(QLabel):
    display = lambda self, v: self.setText(str(v))


class QKeySequenceEdit(QLineEdit):
    keySequenceChanged = Signal(object)
    keySequence = lambda self: QtGui.QKeySequence(self.text())
    setKeySequence = lambda self, s: self.setText(str(s))


class QDateEdit(QLineEdit):
    dateChanged = Signal(object)
    setDate = setCalendarPopup = setDisplayFormat = lambda self, *a: None
    date = lambda self: QtCore.QDate.currentDate()


QTimeEdit = QDateTimeEdit = QDateEdit


class QGraphicsView(QAbstractScrollArea):
    """A drawing surface.  Nothing is painted in the web editor; the calls a plugin makes on it are accepted."""

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


class QGraphicsScene(QObject):
    def __init__(self, *a):
        QObject.__init__(self, next((x for x in a if isinstance(x, QObject)), None))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: _Anything()


class _Anything:
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


class QGraphicsItem(_Anything):
    class GraphicsItemFlag(enum.IntFlag):
        ItemIsMovable = 1
        ItemIsSelectable = 2
        ItemIsFocusable = 4
        ItemSendsGeometryChanges = 0x800

    ItemIsMovable, ItemIsSelectable, ItemIsFocusable, ItemSendsGeometryChanges = (
        GraphicsItemFlag.ItemIsMovable, GraphicsItemFlag.ItemIsSelectable, GraphicsItemFlag.ItemIsFocusable, GraphicsItemFlag.ItemSendsGeometryChanges)

    def __init__(self, *a, **k):
        pass


QGraphicsRectItem = QGraphicsEllipseItem = QGraphicsLineItem = QGraphicsPathItem = QGraphicsTextItem = QGraphicsPixmapItem = \
    QGraphicsPolygonItem = QGraphicsSimpleTextItem = QGraphicsItemGroup = QGraphicsObject = QGraphicsItem


def __getattr__(name):
    """A Qt widget class this module does not have: a plain widget, so a plugin that only places it still opens."""
    if name.startswith("Q") and name[1:2].isupper():
        cls = type(name, (QWidget,), {"__getattr__": lambda self, n: (_ for _ in ()).throw(AttributeError(n)) if n.startswith("_") else (lambda *a, **k: None)})
        globals()[name] = cls
        return cls
    raise AttributeError(name)
