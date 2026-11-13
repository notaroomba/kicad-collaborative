"""PySide6.QtCore for the web editor: signals, timers, the Qt namespace, models and small value types."""

import enum
import inspect
import os
import sys
import time as _time

import wx

__version__ = "6.10.2"


def qVersion():
    return __version__


# ----------------------------------------------------------------------------- signals and slots

_senders = []


def _arity(fn):
    """How many positional arguments `fn` takes, or None when it takes any number."""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return None
    n = 0
    for p in sig.parameters.values():
        if p.kind == p.VAR_POSITIONAL:
            return None
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD):
            n += 1
    return n


class SignalInstance:
    def __init__(self, owner=None, name=""):
        self._owner, self._name, self._slots = owner, name, []

    def connect(self, slot, *a, **k):
        if isinstance(slot, SignalInstance):
            slot = slot.emit
        self._slots.append(slot)
        return slot

    def disconnect(self, slot=None):
        if slot is None:
            self._slots.clear()
            return True
        if isinstance(slot, SignalInstance):
            slot = slot.emit
        for s in list(self._slots):
            if s == slot:
                self._slots.remove(s)
        return True

    def emit(self, *args):
        owner = self._owner
        if owner is not None and getattr(owner, "_q_blocked", False):
            return
        _senders.append(owner)
        try:
            for slot in list(self._slots):
                n = _arity(slot)
                wx._call(slot, *(args if n is None else args[:n]))
        finally:
            _senders.pop()

    def __call__(self, *args):
        self.emit(*args)


class Signal:
    """A signal declared in a class body; each object gets its own connections."""

    def __init__(self, *types, name=None, arguments=None):
        self._name = name or ""

    def __set_name__(self, owner, name):
        self._name = name

    def __get__(self, obj, cls=None):
        if obj is None:
            return self
        key = "_q_sig_" + self._name
        inst = obj.__dict__.get(key)
        if inst is None:
            inst = obj.__dict__[key] = SignalInstance(obj, self._name)
        return inst


def Slot(*types, **kw):
    def wrap(fn):
        return fn
    return wrap


Property = property


# ----------------------------------------------------------------------------- QObject

class QObject:
    destroyed = Signal()
    objectNameChanged = Signal(str)

    def __init__(self, parent=None, *a, **k):
        self._q_parent = parent if isinstance(parent, QObject) else None
        self._q_children = []
        self._q_name = ""
        self._q_blocked = False
        self._q_props = {}
        if self._q_parent is not None:
            self._q_parent._q_children.append(self)

    def objectName(self):
        return getattr(self, "_q_name", "")

    def setObjectName(self, name):
        self._q_name = str(name)

    def parent(self):
        return getattr(self, "_q_parent", None)

    def setParent(self, parent, *a):
        old = getattr(self, "_q_parent", None)
        if old is not None and self in old._q_children:
            old._q_children.remove(self)
        self._q_parent = parent if isinstance(parent, QObject) else None
        if self._q_parent is not None:
            self._q_parent._q_children.append(self)

    def children(self):
        return list(self._q_children)

    def findChild(self, kind=None, name=""):
        for c in self._q_children:
            if (kind is None or isinstance(c, kind)) and (not name or c.objectName() == name):
                return c
            r = c.findChild(kind, name)
            if r is not None:
                return r
        return None

    def findChildren(self, kind=None, name=""):
        out = []
        for c in self._q_children:
            if (kind is None or isinstance(c, kind)) and (not name or c.objectName() == name):
                out.append(c)
            out.extend(c.findChildren(kind, name))
        return out

    def blockSignals(self, block):
        old = getattr(self, "_q_blocked", False)
        self._q_blocked = bool(block)
        return old

    def signalsBlocked(self):
        return getattr(self, "_q_blocked", False)

    def sender(self):
        return _senders[-1] if _senders else None

    def setProperty(self, name, value):
        self._q_props[str(name)] = value
        return True

    def property(self, name):
        return self._q_props.get(str(name))

    def deleteLater(self):
        self.setParent(None)

    def tr(self, text, *a):
        return text

    def installEventFilter(self, *a):
        pass

    removeEventFilter = installEventFilter

    def event(self, e):
        return False

    def eventFilter(self, obj, e):
        return False

    def startTimer(self, *a):
        return 0

    def killTimer(self, *a):
        pass

    def moveToThread(self, thread):
        self._q_thread = thread

    def thread(self):
        return getattr(self, "_q_thread", None)

    def inherits(self, name):
        return any(c.__name__ == name for c in type(self).__mro__)

    def metaObject(self):
        return _Meta(type(self))

    def isWidgetType(self):
        return False


class _Meta:
    def __init__(self, cls):
        self._cls = cls

    def className(self):
        return self._cls.__name__


class QMetaObject:
    @staticmethod
    def connectSlotsByName(obj):
        """`on_<objectName>_<signal>` methods are connected to that child's signal, as uic-made code expects."""
        seen = set()
        todo = list(getattr(obj, "_q_children", []))
        while todo:
            c = todo.pop()
            if id(c) in seen:
                continue
            seen.add(id(c))
            todo.extend(getattr(c, "_q_children", []))
            name = c.objectName()
            if not name:
                continue
            prefix = f"on_{name}_"
            for attr in dir(type(obj)):
                if attr.startswith(prefix):
                    sig = getattr(c, attr[len(prefix):], None)
                    if isinstance(sig, SignalInstance):
                        sig.connect(getattr(obj, attr))

    @staticmethod
    def invokeMethod(obj, name, *a):
        fn = getattr(obj, name if isinstance(name, str) else "", None)
        if callable(fn):
            QTimer.singleShot(0, fn)
        return True


# ----------------------------------------------------------------------------- the application object

_pending = []            # headless: single shots that are due when the event loop starts


class QCoreApplication(QObject):
    aboutToQuit = Signal()
    _instance = None
    _names = {}

    def __init__(self, argv=None):
        super().__init__()
        QCoreApplication._instance = self
        self._wx_app = wx.GetApp()

    @staticmethod
    def instance():
        return QCoreApplication._instance

    @staticmethod
    def translate(context, text, disambiguation=None, n=-1):
        return text

    @staticmethod
    def processEvents(*a):
        wx.Yield()

    @staticmethod
    def sendPostedEvents(*a):
        pass

    @staticmethod
    def applicationDirPath():
        return os.path.dirname(os.path.abspath(sys.argv[0])) if sys.argv and sys.argv[0] else os.getcwd()

    @staticmethod
    def applicationFilePath():
        return os.path.abspath(sys.argv[0]) if sys.argv and sys.argv[0] else sys.executable

    @staticmethod
    def arguments():
        return list(sys.argv)

    @classmethod
    def _set(cls, key, value):
        cls._names[key] = value

    setApplicationName = classmethod(lambda cls, v: cls._set("name", v))
    setOrganizationName = classmethod(lambda cls, v: cls._set("org", v))
    setOrganizationDomain = classmethod(lambda cls, v: cls._set("domain", v))
    setApplicationVersion = classmethod(lambda cls, v: cls._set("version", v))
    applicationName = classmethod(lambda cls: cls._names.get("name", "plugin"))
    organizationName = classmethod(lambda cls: cls._names.get("org", ""))
    organizationDomain = classmethod(lambda cls: cls._names.get("domain", ""))
    applicationVersion = classmethod(lambda cls: cls._names.get("version", ""))
    setAttribute = staticmethod(lambda *a: None)
    testAttribute = staticmethod(lambda *a: False)
    installTranslator = staticmethod(lambda *a: True)
    removeTranslator = staticmethod(lambda *a: True)
    setLibraryPaths = addLibraryPath = staticmethod(lambda *a: None)
    libraryPaths = staticmethod(lambda: [])

    def exec(self):
        """The event loop: this call lasts until the program's last window is closed."""
        while _pending:
            fn = _pending.pop(0)
            wx._call(fn)
        code = self._wx_app.MainLoop()
        self.aboutToQuit.emit()
        return code or 0

    exec_ = exec

    @staticmethod
    def quit():
        app = wx.GetApp()
        for w in list(wx.GetTopLevelWindows()):
            if getattr(w, "_wx_visible", False) and getattr(w, "_q_owner", None) is not None:
                w._q_owner.close()
        app.ExitMainLoop()

    @staticmethod
    def exit(code=0):
        QCoreApplication.quit()


class QEventLoop(QObject):
    def exec(self, *a):
        return 0

    exec_ = exec

    def quit(self):
        pass

    exit = processEvents = lambda self, *a: None
    isRunning = lambda self: False


# ----------------------------------------------------------------------------- animations

class QEasingCurve:
    class Type(enum.IntEnum):
        Linear, InQuad, OutQuad, InOutQuad, OutInQuad, InCubic, OutCubic, InOutCubic, OutInCubic = range(9)
        InOutSine, OutBounce, OutBack, InBack, InOutBack, OutElastic = 14, 41, 34, 33, 35, 30

    def __init__(self, kind=None):
        self._type = QEasingCurve.Type.Linear if kind is None else kind

    def type(self):
        return self._type

    def setType(self, kind):
        self._type = kind

    def valueForProgress(self, t):
        t = max(0.0, min(1.0, float(t)))
        name = getattr(self._type, "name", "Linear")
        if name.startswith("InOut"):
            return 2 * t * t if t < 0.5 else 1 - 2 * (1 - t) * (1 - t)
        if name.startswith("Out"):
            return 1 - (1 - t) * (1 - t)
        if name.startswith("In"):
            return t * t
        return t


for _n, _v in QEasingCurve.Type.__members__.items():
    setattr(QEasingCurve, _n, _v)


class QAbstractAnimation(QObject):
    finished = Signal()
    stateChanged = Signal(object, object)
    Stopped, Paused, Running = 0, 1, 2
    KeepWhenStopped, DeleteWhenStopped = 0, 1

    def __init__(self, parent=None):
        super().__init__(parent)
        self._duration, self._state, self._loops = 250, 0, 1

    def duration(self):
        return self._duration

    def setDuration(self, ms):
        self._duration = int(ms)

    def setLoopCount(self, n):
        self._loops = int(n)

    def state(self):
        return self._state

    def stop(self):
        self._state = 0

    def pause(self):
        pass

    def resume(self):
        pass


class QVariantAnimation(QAbstractAnimation):
    valueChanged = Signal(object)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._start = self._end = None
        self._curve = QEasingCurve()

    def setStartValue(self, v):
        self._start = v

    def startValue(self):
        return self._start

    def setEndValue(self, v):
        self._end = v

    def endValue(self):
        return self._end

    def setEasingCurve(self, c):
        self._curve = c if isinstance(c, QEasingCurve) else QEasingCurve(c)

    def easingCurve(self):
        return self._curve

    def currentValue(self):
        return self._end

    def _apply(self, v):
        self.valueChanged.emit(v)

    def start(self, *_):
        # The page does not step values between frames: the animation arrives at once, as Qt's does when its
        # duration is over, and says it finished.
        self._state = 2
        if self._end is not None:
            self._apply(self._end)
        self._state = 0
        self.finished.emit()


class QPropertyAnimation(QVariantAnimation):
    def __init__(self, target=None, prop=b"", parent=None):
        super().__init__(parent)
        self._target = target
        self._prop = prop.decode() if isinstance(prop, (bytes, bytearray)) else str(prop or "")

    def setTargetObject(self, o):
        self._target = o

    def targetObject(self):
        return self._target

    def setPropertyName(self, name):
        self._prop = name.decode() if isinstance(name, (bytes, bytearray)) else str(name)

    def propertyName(self):
        return self._prop.encode()

    def _apply(self, v):
        t, n = self._target, self._prop
        if t is not None and n:
            setter = getattr(t, "set" + n[:1].upper() + n[1:], None)
            if callable(setter):
                setter(v)
            else:
                t.setProperty(n, v)
        self.valueChanged.emit(v)


# ----------------------------------------------------------------------------- timers and time

class QTimer(QObject):
    timeout = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._interval, self._single, self._timer = 0, False, None

    def setInterval(self, ms):
        self._interval = int(ms)

    def interval(self):
        return self._interval

    def setSingleShot(self, on):
        self._single = bool(on)

    def isSingleShot(self):
        return self._single

    def setTimerType(self, *a):
        pass

    def start(self, ms=None):
        if ms is not None:
            self._interval = int(ms)
        self.stop()
        if not wx._DOM:
            if self._single:
                _pending.append(self.timeout.emit)
            return
        t = self._timer = wx.Timer()
        t.Notify = self._fire
        t.Start(max(0, self._interval), self._single)

    def _fire(self):
        if self._single:
            self._timer = None
        self.timeout.emit()

    def stop(self):
        if self._timer is not None:
            self._timer.Stop()
            self._timer = None

    def isActive(self):
        return self._timer is not None and self._timer.IsRunning()

    def remainingTime(self):
        return self._interval if self.isActive() else -1

    @staticmethod
    def singleShot(ms, *a):
        fn = a[-1] if a else None
        if not callable(fn):
            return
        if not wx._DOM:
            _pending.append(fn)
            return
        wx.CallLater(max(0, int(ms)), fn)


class QElapsedTimer:
    def __init__(self):
        self._t = _time.monotonic()

    def start(self):
        self._t = _time.monotonic()

    def restart(self):
        e = self.elapsed()
        self._t = _time.monotonic()
        return e

    def elapsed(self):
        return int((_time.monotonic() - self._t) * 1000)

    def nsecsElapsed(self):
        return int((_time.monotonic() - self._t) * 1e9)

    def isValid(self):
        return True

    def hasExpired(self, ms):
        return self.elapsed() > ms


class QThread(QObject):
    """A thread.  There is one thread in a browser's interpreter, so the work runs when it is started."""
    started = Signal()
    finished = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._running = self._done = self._stop = False

    def run(self):
        pass

    def start(self, *a):
        import kicad_web
        self._running, self._done = True, False
        self.started.emit()
        kicad_web.run_thread(self, self.run)       # a worker that waits at its job queue stays "running" until a job ends it

    def _kc_done(self):
        self._running, self._done = False, True
        self.finished.emit()

    def quit(self):
        self._stop = True

    exit = terminate = lambda self, *a: self.quit()

    def wait(self, *a):
        return True

    def isRunning(self):
        return self._running

    def isFinished(self):
        return self._done

    def requestInterruption(self):
        self._stop = True

    def isInterruptionRequested(self):
        return self._stop

    setPriority = setTerminationEnabled = setStackSize = lambda self, *a: None

    @staticmethod
    def currentThread():
        return _main_thread

    @staticmethod
    def msleep(ms):
        wx.Yield()

    sleep = usleep = msleep


_main_thread = QThread()


class QRunnable:
    def run(self):
        pass

    def setAutoDelete(self, *a):
        pass

    autoDelete = lambda self: True


class QThreadPool(QObject):
    _global = None

    @staticmethod
    def globalInstance():
        if QThreadPool._global is None:
            QThreadPool._global = QThreadPool()
        return QThreadPool._global

    def start(self, job, *a):
        wx._call(job.run if hasattr(job, "run") else job)

    tryStart = lambda self, job: (self.start(job), True)[1]
    setMaxThreadCount = clear = lambda self, *a: None
    maxThreadCount = lambda self: 1
    activeThreadCount = lambda self: 0
    waitForDone = lambda self, *a: True


class QMutex:
    def lock(self):
        pass

    unlock = lock
    tryLock = lambda self, *a: True


class QMutexLocker:
    def __init__(self, *a):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    unlock = relock = lambda self: None


# ----------------------------------------------------------------------------- geometry

class QPoint:
    def __init__(self, x=0, y=0):
        if isinstance(x, QPoint):
            x, y = x._x, x._y
        self._x, self._y = x, y

    x = lambda self: self._x
    y = lambda self: self._y

    def setX(self, v):
        self._x = v

    def setY(self, v):
        self._y = v

    def isNull(self):
        return not self._x and not self._y

    def manhattanLength(self):
        return abs(self._x) + abs(self._y)

    def toPoint(self):
        return QPoint(int(round(self._x)), int(round(self._y)))

    def toPointF(self):
        return QPointF(self._x, self._y)

    def toTuple(self):
        return (self._x, self._y)

    def __add__(self, o):
        return type(self)(self._x + o._x, self._y + o._y)

    def __sub__(self, o):
        return type(self)(self._x - o._x, self._y - o._y)

    def __mul__(self, f):
        return type(self)(self._x * f, self._y * f)

    __rmul__ = __mul__

    def __truediv__(self, f):
        return type(self)(self._x / f, self._y / f)

    def __neg__(self):
        return type(self)(-self._x, -self._y)

    def __eq__(self, o):
        return isinstance(o, QPoint) and (self._x, self._y) == (o._x, o._y)

    def __hash__(self):
        return hash((self._x, self._y))

    def __repr__(self):
        return f"{type(self).__name__}({self._x}, {self._y})"


class QPointF(QPoint):
    def __init__(self, x=0.0, y=0.0):
        QPoint.__init__(self, x, y)
        self._x, self._y = float(self._x), float(self._y)


class QSize:
    def __init__(self, w=-1, h=-1):
        if isinstance(w, QSize):
            w, h = w._w, w._h
        self._w, self._h = w, h

    width = lambda self: self._w
    height = lambda self: self._h

    def setWidth(self, v):
        self._w = v

    def setHeight(self, v):
        self._h = v

    def isValid(self):
        return self._w >= 0 and self._h >= 0

    def isEmpty(self):
        return self._w <= 0 or self._h <= 0

    isNull = lambda self: not self._w and not self._h

    def expandedTo(self, o):
        return type(self)(max(self._w, o._w), max(self._h, o._h))

    def boundedTo(self, o):
        return type(self)(min(self._w, o._w), min(self._h, o._h))

    def scaled(self, *a):
        return type(self)(self._w, self._h)

    def toSize(self):
        return QSize(int(round(self._w)), int(round(self._h)))

    def toTuple(self):
        return (self._w, self._h)

    def __mul__(self, f):
        return type(self)(self._w * f, self._h * f)

    __rmul__ = __mul__

    def __truediv__(self, f):
        return type(self)(self._w / f, self._h / f)

    def __eq__(self, o):
        return isinstance(o, QSize) and (self._w, self._h) == (o._w, o._h)

    def __hash__(self):
        return hash((self._w, self._h))

    def __repr__(self):
        return f"{type(self).__name__}({self._w}, {self._h})"


class QSizeF(QSize):
    pass


class QRect:
    def __init__(self, x=0, y=0, w=0, h=0):
        if isinstance(x, QRect):
            x, y, w, h = x._x, x._y, x._w, x._h
        elif isinstance(x, QPoint) and isinstance(y, QSize):
            x, y, w, h = x._x, x._y, y._w, y._h
        elif isinstance(x, QPoint) and isinstance(y, QPoint):
            x, y, w, h = x._x, x._y, y._x - x._x, y._y - x._y
        self._x, self._y, self._w, self._h = x, y, w, h

    x = left = lambda self: self._x
    y = top = lambda self: self._y
    width = lambda self: self._w
    height = lambda self: self._h
    right = lambda self: self._x + self._w
    bottom = lambda self: self._y + self._h

    def size(self):
        return QSize(self._w, self._h)

    def topLeft(self):
        return QPoint(self._x, self._y)

    def bottomRight(self):
        return QPoint(self._x + self._w, self._y + self._h)

    def topRight(self):
        return QPoint(self._x + self._w, self._y)

    def bottomLeft(self):
        return QPoint(self._x, self._y + self._h)

    def center(self):
        return QPoint(self._x + self._w / 2, self._y + self._h / 2)

    def setRect(self, x, y, w, h):
        self._x, self._y, self._w, self._h = x, y, w, h

    def setX(self, v):
        self._x = v

    def setY(self, v):
        self._y = v

    setLeft, setTop = setX, setY

    def setWidth(self, v):
        self._w = v

    def setHeight(self, v):
        self._h = v

    def setSize(self, s):
        self._w, self._h = s._w, s._h

    def moveTo(self, *a):
        p = a[0] if len(a) == 1 else QPoint(*a)
        self._x, self._y = p._x, p._y

    moveTopLeft = moveTo

    def moveCenter(self, p):
        self._x, self._y = p._x - self._w / 2, p._y - self._h / 2

    def translated(self, dx, dy=None):
        if dy is None:
            dx, dy = dx._x, dx._y
        return type(self)(self._x + dx, self._y + dy, self._w, self._h)

    def translate(self, dx, dy=None):
        if dy is None:
            dx, dy = dx._x, dx._y
        self._x += dx
        self._y += dy

    def adjusted(self, a, b, c, d):
        return type(self)(self._x + a, self._y + b, self._w - a + c, self._h - b + d)

    def adjust(self, a, b, c, d):
        self._x, self._y, self._w, self._h = self._x + a, self._y + b, self._w - a + c, self._h - b + d

    def contains(self, *a):
        p = a[0] if len(a) == 1 else QPoint(*a[:2])
        if isinstance(p, QRect):
            return self._x <= p._x and self._y <= p._y and p._x + p._w <= self._x + self._w and p._y + p._h <= self._y + self._h
        return self._x <= p._x <= self._x + self._w and self._y <= p._y <= self._y + self._h

    def intersects(self, o):
        return not (o._x > self._x + self._w or o._x + o._w < self._x or o._y > self._y + self._h or o._y + o._h < self._y)

    def united(self, o):
        x, y = min(self._x, o._x), min(self._y, o._y)
        return type(self)(x, y, max(self._x + self._w, o._x + o._w) - x, max(self._y + self._h, o._y + o._h) - y)

    def intersected(self, o):
        x, y = max(self._x, o._x), max(self._y, o._y)
        return type(self)(x, y, max(0, min(self._x + self._w, o._x + o._w) - x), max(0, min(self._y + self._h, o._y + o._h) - y))

    def normalized(self):
        return type(self)(min(self._x, self._x + self._w), min(self._y, self._y + self._h), abs(self._w), abs(self._h))

    def isEmpty(self):
        return self._w <= 0 or self._h <= 0

    isNull = lambda self: not self._w and not self._h
    isValid = lambda self: self._w > 0 and self._h > 0

    def toRect(self):
        return QRect(int(round(self._x)), int(round(self._y)), int(round(self._w)), int(round(self._h)))

    def toRectF(self):
        return QRectF(self._x, self._y, self._w, self._h)

    def getRect(self):
        return (self._x, self._y, self._w, self._h)

    def __eq__(self, o):
        return isinstance(o, QRect) and self.getRect() == o.getRect()

    def __hash__(self):
        return hash(self.getRect())

    def __repr__(self):
        return f"{type(self).__name__}({self._x}, {self._y}, {self._w}, {self._h})"


class QRectF(QRect):
    pass


class QLine:
    def __init__(self, *a):
        if len(a) == 2:
            a = (a[0]._x, a[0]._y, a[1]._x, a[1]._y)
        self._c = tuple(a) if len(a) == 4 else (0, 0, 0, 0)

    x1 = lambda self: self._c[0]
    y1 = lambda self: self._c[1]
    x2 = lambda self: self._c[2]
    y2 = lambda self: self._c[3]
    p1 = lambda self: QPointF(self._c[0], self._c[1])
    p2 = lambda self: QPointF(self._c[2], self._c[3])

    def length(self):
        return ((self._c[2] - self._c[0]) ** 2 + (self._c[3] - self._c[1]) ** 2) ** 0.5


QLineF = QLine


class QMargins:
    def __init__(self, left=0, top=0, right=0, bottom=0):
        self._m = (left, top, right, bottom)

    left = lambda self: self._m[0]
    top = lambda self: self._m[1]
    right = lambda self: self._m[2]
    bottom = lambda self: self._m[3]


QMarginsF = QMargins


# ----------------------------------------------------------------------------- the Qt namespace

class _Flag(enum.IntFlag):
    pass


class Qt:
    class Orientation(_Flag):
        Horizontal = 1
        Vertical = 2

    class AlignmentFlag(_Flag):
        AlignLeft = 0x1
        AlignLeading = 0x1
        AlignRight = 0x2
        AlignTrailing = 0x2
        AlignHCenter = 0x4
        AlignJustify = 0x8
        AlignAbsolute = 0x10
        AlignTop = 0x20
        AlignBottom = 0x40
        AlignVCenter = 0x80
        AlignBaseline = 0x100
        AlignCenter = 0x84
        AlignHorizontal_Mask = 0x1f
        AlignVertical_Mask = 0x1e0

    class ItemDataRole(enum.IntEnum):
        DisplayRole = 0
        DecorationRole = 1
        EditRole = 2
        ToolTipRole = 3
        StatusTipRole = 4
        WhatsThisRole = 5
        FontRole = 6
        TextAlignmentRole = 7
        BackgroundRole = 8
        ForegroundRole = 9
        CheckStateRole = 10
        AccessibleTextRole = 11
        AccessibleDescriptionRole = 12
        SizeHintRole = 13
        InitialSortOrderRole = 14
        UserRole = 0x100

    class CheckState(enum.IntEnum):
        Unchecked = 0
        PartiallyChecked = 1
        Checked = 2

    class ItemFlag(_Flag):
        NoItemFlags = 0
        ItemIsSelectable = 1
        ItemIsEditable = 2
        ItemIsDragEnabled = 4
        ItemIsDropEnabled = 8
        ItemIsUserCheckable = 16
        ItemIsEnabled = 32
        ItemIsAutoTristate = 64
        ItemNeverHasChildren = 128
        ItemIsUserTristate = 256

    class SortOrder(enum.IntEnum):
        AscendingOrder = 0
        DescendingOrder = 1

    class CaseSensitivity(enum.IntEnum):
        CaseInsensitive = 0
        CaseSensitive = 1

    class WindowType(_Flag):
        Widget = 0
        Window = 1
        Dialog = 3
        Sheet = 5
        Popup = 9
        Tool = 11
        ToolTip = 13
        SplashScreen = 15
        FramelessWindowHint = 0x800
        WindowTitleHint = 0x1000
        WindowSystemMenuHint = 0x2000
        WindowMinimizeButtonHint = 0x4000
        WindowMaximizeButtonHint = 0x8000
        WindowMinMaxButtonsHint = 0xc000
        WindowContextHelpButtonHint = 0x10000
        WindowStaysOnTopHint = 0x40000
        WindowCloseButtonHint = 0x8000000
        CustomizeWindowHint = 0x2000000
        WindowStaysOnBottomHint = 0x4000000

    class WindowModality(enum.IntEnum):
        NonModal = 0
        WindowModal = 1
        ApplicationModal = 2

    class WindowState(_Flag):
        WindowNoState = 0
        WindowMinimized = 1
        WindowMaximized = 2
        WindowFullScreen = 4
        WindowActive = 8

    class WidgetAttribute(enum.IntEnum):
        WA_DeleteOnClose = 55
        WA_TranslucentBackground = 120
        WA_StyledBackground = 93
        WA_TransparentForMouseEvents = 51
        WA_ShowWithoutActivating = 98
        WA_MacShowFocusRect = 88
        WA_Hover = 74
        WA_NoSystemBackground = 9
        WA_OpaquePaintEvent = 4
        WA_AlwaysShowToolTips = 84
        WA_QuitOnClose = 76
        WA_InputMethodEnabled = 14

    class ApplicationAttribute(enum.IntEnum):
        AA_EnableHighDpiScaling = 20
        AA_UseHighDpiPixmaps = 13
        AA_ShareOpenGLContexts = 10
        AA_DontShowIconsInMenus = 2
        AA_UseDesktopOpenGL = 15
        AA_UseSoftwareOpenGL = 17
        AA_DisableWindowContextHelpButton = 30

    class HighDpiScaleFactorRoundingPolicy(enum.IntEnum):
        Round = 1
        Ceil = 2
        Floor = 3
        RoundPreferFloor = 4
        PassThrough = 5

    class ScrollBarPolicy(enum.IntEnum):
        ScrollBarAsNeeded = 0
        ScrollBarAlwaysOff = 1
        ScrollBarAlwaysOn = 2

    class FocusPolicy(enum.IntEnum):
        NoFocus = 0
        TabFocus = 1
        ClickFocus = 2
        StrongFocus = 11
        WheelFocus = 15

    class FocusReason(enum.IntEnum):
        MouseFocusReason = 0
        TabFocusReason = 1
        OtherFocusReason = 7

    class CursorShape(enum.IntEnum):
        ArrowCursor = 0
        UpArrowCursor = 1
        CrossCursor = 2
        WaitCursor = 3
        IBeamCursor = 4
        SizeVerCursor = 5
        SizeHorCursor = 6
        SizeBDiagCursor = 7
        SizeFDiagCursor = 8
        SizeAllCursor = 9
        BlankCursor = 10
        SplitVCursor = 11
        SplitHCursor = 12
        PointingHandCursor = 13
        ForbiddenCursor = 14
        WhatsThisCursor = 15
        BusyCursor = 16
        OpenHandCursor = 17
        ClosedHandCursor = 18

    class PenStyle(enum.IntEnum):
        NoPen = 0
        SolidLine = 1
        DashLine = 2
        DotLine = 3
        DashDotLine = 4
        DashDotDotLine = 5

    class PenCapStyle(enum.IntEnum):
        FlatCap = 0
        SquareCap = 0x10
        RoundCap = 0x20

    class PenJoinStyle(enum.IntEnum):
        MiterJoin = 0
        BevelJoin = 0x40
        RoundJoin = 0x80

    class BrushStyle(enum.IntEnum):
        NoBrush = 0
        SolidPattern = 1

    class GlobalColor(enum.IntEnum):
        color0 = 0
        color1 = 1
        black = 2
        white = 3
        darkGray = 4
        gray = 5
        lightGray = 6
        red = 7
        green = 8
        blue = 9
        cyan = 10
        magenta = 11
        yellow = 12
        darkRed = 13
        darkGreen = 14
        darkBlue = 15
        darkCyan = 16
        darkMagenta = 17
        darkYellow = 18
        transparent = 19

    class TextFormat(enum.IntEnum):
        PlainText = 0
        RichText = 1
        AutoText = 2
        MarkdownText = 3

    class TextInteractionFlag(_Flag):
        NoTextInteraction = 0
        TextSelectableByMouse = 1
        TextSelectableByKeyboard = 2
        LinksAccessibleByMouse = 4
        LinksAccessibleByKeyboard = 8
        TextEditable = 16
        TextEditorInteraction = 19
        TextBrowserInteraction = 13

    class TextElideMode(enum.IntEnum):
        ElideLeft = 0
        ElideRight = 1
        ElideMiddle = 2
        ElideNone = 3

    class TextFlag(_Flag):
        TextSingleLine = 0x100
        TextDontClip = 0x200
        TextExpandTabs = 0x400
        TextShowMnemonic = 0x800
        TextWordWrap = 0x1000
        TextWrapAnywhere = 0x2000

    class AspectRatioMode(enum.IntEnum):
        IgnoreAspectRatio = 0
        KeepAspectRatio = 1
        KeepAspectRatioByExpanding = 2

    class TransformationMode(enum.IntEnum):
        FastTransformation = 0
        SmoothTransformation = 1

    class ToolButtonStyle(enum.IntEnum):
        ToolButtonIconOnly = 0
        ToolButtonTextOnly = 1
        ToolButtonTextBesideIcon = 2
        ToolButtonTextUnderIcon = 3
        ToolButtonFollowStyle = 4

    class ContextMenuPolicy(enum.IntEnum):
        NoContextMenu = 0
        DefaultContextMenu = 1
        ActionsContextMenu = 2
        CustomContextMenu = 3
        PreventContextMenu = 4

    class ConnectionType(enum.IntEnum):
        AutoConnection = 0
        DirectConnection = 1
        QueuedConnection = 2
        BlockingQueuedConnection = 3
        UniqueConnection = 0x80

    class MatchFlag(_Flag):
        MatchExactly = 0
        MatchContains = 1
        MatchStartsWith = 2
        MatchEndsWith = 3
        MatchFixedString = 8
        MatchCaseSensitive = 16
        MatchWrap = 32
        MatchRecursive = 64

    class KeyboardModifier(_Flag):
        NoModifier = 0
        ShiftModifier = 0x02000000
        ControlModifier = 0x04000000
        AltModifier = 0x08000000
        MetaModifier = 0x10000000
        KeypadModifier = 0x20000000

    class MouseButton(_Flag):
        NoButton = 0
        LeftButton = 1
        RightButton = 2
        MiddleButton = 4

    class Key(enum.IntEnum):
        Key_Escape = 0x01000000
        Key_Tab = 0x01000001
        Key_Backspace = 0x01000003
        Key_Return = 0x01000004
        Key_Enter = 0x01000005
        Key_Insert = 0x01000006
        Key_Delete = 0x01000007
        Key_Home = 0x01000010
        Key_End = 0x01000011
        Key_Left = 0x01000012
        Key_Up = 0x01000013
        Key_Right = 0x01000014
        Key_Down = 0x01000015
        Key_PageUp = 0x01000016
        Key_PageDown = 0x01000017
        Key_Shift = 0x01000020
        Key_Control = 0x01000021
        Key_Alt = 0x01000023
        Key_F1 = 0x01000030
        Key_F2 = 0x01000031
        Key_F3 = 0x01000032
        Key_F4 = 0x01000033
        Key_F5 = 0x01000034
        Key_Space = 0x20
        Key_Plus = 0x2b
        Key_Minus = 0x2d
        Key_0 = 0x30
        Key_A = 0x41
        Key_C = 0x43
        Key_F = 0x46
        Key_K = 0x4b
        Key_L = 0x4c
        Key_N = 0x4e
        Key_O = 0x4f
        Key_P = 0x50
        Key_Q = 0x51
        Key_R = 0x52
        Key_S = 0x53
        Key_V = 0x56
        Key_W = 0x57
        Key_X = 0x58
        Key_Y = 0x59
        Key_Z = 0x5a

    class LayoutDirection(enum.IntEnum):
        LeftToRight = 0
        RightToLeft = 1
        LayoutDirectionAuto = 2

    class ArrowType(enum.IntEnum):
        NoArrow = 0
        UpArrow = 1
        DownArrow = 2
        LeftArrow = 3
        RightArrow = 4

    class SizeMode(enum.IntEnum):
        AbsoluteSize = 0
        RelativeSize = 1

    class FillRule(enum.IntEnum):
        OddEvenFill = 0
        WindingFill = 1

    class DropAction(_Flag):
        IgnoreAction = 0
        CopyAction = 1
        MoveAction = 2
        LinkAction = 4

    class ShortcutContext(enum.IntEnum):
        WidgetShortcut = 0
        WindowShortcut = 1
        ApplicationShortcut = 2
        WidgetWithChildrenShortcut = 3

    class TimerType(enum.IntEnum):
        PreciseTimer = 0
        CoarseTimer = 1
        VeryCoarseTimer = 2

    class DateFormat(enum.IntEnum):
        TextDate = 0
        ISODate = 1

    class ColorScheme(enum.IntEnum):
        Unknown = 0
        Light = 1
        Dark = 2


# Qt 5 style access: Qt.AlignCenter beside Qt.AlignmentFlag.AlignCenter
for _name, _group in list(vars(Qt).items()):
    if isinstance(_group, type) and issubclass(_group, enum.Enum):
        for _member in _group:
            if not hasattr(Qt, _member.name):
                setattr(Qt, _member.name, _member)
Qt.Alignment = Qt.AlignmentFlag
Qt.ItemFlags = Qt.ItemFlag
Qt.WindowFlags = Qt.WindowType
Qt.KeyboardModifiers = Qt.KeyboardModifier
Qt.MouseButtons = Qt.MouseButton


# ----------------------------------------------------------------------------- models

class QModelIndex:
    def __init__(self, row=-1, column=-1, model=None, ptr=None):
        self._row, self._col, self._model, self._ptr = row, column, model, ptr

    def isValid(self):
        return self._row >= 0 and self._col >= 0 and self._model is not None

    row = lambda self: self._row
    column = lambda self: self._col
    model = lambda self: self._model
    internalPointer = lambda self: self._ptr
    internalId = lambda self: id(self._ptr)

    def parent(self):
        return QModelIndex()

    def data(self, role=0):
        return self._model.data(self, role) if self.isValid() else None

    def flags(self):
        return self._model.flags(self) if self.isValid() else Qt.ItemFlag.NoItemFlags

    def sibling(self, row, column):
        return self._model.index(row, column) if self._model is not None else QModelIndex()

    def siblingAtColumn(self, column):
        return self.sibling(self._row, column)

    def siblingAtRow(self, row):
        return self.sibling(row, self._col)

    def __eq__(self, o):
        return isinstance(o, QModelIndex) and (self._row, self._col, self._model) == (o._row, o._col, o._model)

    def __hash__(self):
        return hash((self._row, self._col, id(self._model)))


QPersistentModelIndex = QModelIndex


class QAbstractItemModel(QObject):
    dataChanged = Signal(object, object, object)
    headerDataChanged = Signal(object, int, int)
    layoutChanged = Signal()
    layoutAboutToBeChanged = Signal()
    modelReset = Signal()
    modelAboutToBeReset = Signal()
    rowsInserted = Signal(object, int, int)
    rowsRemoved = Signal(object, int, int)
    rowsAboutToBeInserted = Signal(object, int, int)
    rowsAboutToBeRemoved = Signal(object, int, int)
    columnsInserted = Signal(object, int, int)
    columnsRemoved = Signal(object, int, int)

    def index(self, row, column=0, parent=None):
        if 0 <= row < self.rowCount() and 0 <= column < self.columnCount():
            return QModelIndex(row, column, self)
        return QModelIndex()

    def createIndex(self, row, column, ptr=None):
        return QModelIndex(row, column, self, ptr)

    def parent(self, *a):
        return QModelIndex() if a else QObject.parent(self)

    def rowCount(self, parent=None):
        return 0

    def columnCount(self, parent=None):
        return 0

    def data(self, index, role=0):
        return None

    def setData(self, index, value, role=2):
        return False

    def headerData(self, section, orientation, role=0):
        return None

    def setHeaderData(self, *a):
        return False

    def flags(self, index):
        return Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEnabled

    def hasChildren(self, parent=None):
        return False

    def hasIndex(self, row, column, parent=None):
        return 0 <= row < self.rowCount() and 0 <= column < self.columnCount()

    def sort(self, column, order=0):
        pass

    def beginResetModel(self):
        self.modelAboutToBeReset.emit()

    def endResetModel(self):
        self.modelReset.emit()

    def beginInsertRows(self, parent, first, last):
        self._q_span = (parent, first, last)

    def endInsertRows(self):
        self.rowsInserted.emit(*getattr(self, "_q_span", (QModelIndex(), 0, 0)))

    def beginRemoveRows(self, parent, first, last):
        self._q_span = (parent, first, last)

    def endRemoveRows(self):
        self.rowsRemoved.emit(*getattr(self, "_q_span", (QModelIndex(), 0, 0)))

    def beginInsertColumns(self, parent, first, last):
        self._q_span = (parent, first, last)

    def endInsertColumns(self):
        self.columnsInserted.emit(*getattr(self, "_q_span", (QModelIndex(), 0, 0)))

    beginRemoveColumns = beginInsertColumns

    def endRemoveColumns(self):
        self.columnsRemoved.emit(*getattr(self, "_q_span", (QModelIndex(), 0, 0)))

    beginMoveRows = lambda self, *a: True
    endMoveRows = lambda self: self.layoutChanged.emit()

    def insertRows(self, *a):
        return False

    removeRows = insertColumns = removeColumns = insertRows
    insertRow = lambda self, row, parent=None: self.insertRows(row, 1, parent)
    removeRow = lambda self, row, parent=None: self.removeRows(row, 1, parent)

    def roleNames(self):
        return {}

    def match(self, *a, **k):
        return []

    def canFetchMore(self, *a):
        return False

    def fetchMore(self, *a):
        pass

    def supportedDropActions(self):
        return Qt.DropAction.CopyAction

    mimeTypes = lambda self: []
    mimeData = lambda self, *a: None
    dropMimeData = lambda self, *a: False
    submit = lambda self: True
    revert = lambda self: None


class QAbstractTableModel(QAbstractItemModel):
    pass


class QAbstractListModel(QAbstractItemModel):
    def columnCount(self, parent=None):
        return 1


class QStringListModel(QAbstractListModel):
    def __init__(self, strings=None, parent=None):
        if isinstance(strings, QObject):
            strings, parent = None, strings
        super().__init__(parent)
        self._strings = list(strings or [])

    def rowCount(self, parent=None):
        return len(self._strings)

    def data(self, index, role=0):
        if index.isValid() and role in (0, 2):
            return self._strings[index.row()]
        return None

    def stringList(self):
        return list(self._strings)

    def setStringList(self, strings):
        self.beginResetModel()
        self._strings = list(strings)
        self.endResetModel()


class QSortFilterProxyModel(QAbstractItemModel):
    """A proxy that filters rows by text and sorts by a column."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._source, self._rows = None, []
        self._text, self._key_col, self._case = "", 0, Qt.CaseSensitivity.CaseSensitive
        self._sort = (-1, 0)

    def setSourceModel(self, model):
        self._source = model
        for name in ("modelReset", "layoutChanged", "rowsInserted", "rowsRemoved", "dataChanged"):
            getattr(model, name).connect(lambda *a: self.invalidate())
        self.invalidate()

    def sourceModel(self):
        return self._source

    def filterAcceptsRow(self, row, parent=None):
        if not self._text:
            return True
        cols = range(self._source.columnCount()) if self._key_col < 0 else [self._key_col]
        needle = self._text if self._case == Qt.CaseSensitivity.CaseSensitive else self._text.lower()
        for c in cols:
            v = self._source.data(self._source.index(row, c), 0)
            s = "" if v is None else str(v)
            if needle in (s if self._case == Qt.CaseSensitivity.CaseSensitive else s.lower()):
                return True
        return False

    def lessThan(self, left, right):
        a, b = self._source.data(left, 0), self._source.data(right, 0)
        try:
            return a < b
        except TypeError:
            return str(a) < str(b)

    def invalidate(self):
        if self._source is None:
            self._rows = []
        else:
            self._rows = [r for r in range(self._source.rowCount()) if self.filterAcceptsRow(r, QModelIndex())]
            col, order = self._sort
            if col >= 0:
                import functools
                src = self._source

                def cmp(x, y):
                    lx, ly = src.index(x, col), src.index(y, col)
                    return -1 if self.lessThan(lx, ly) else (1 if self.lessThan(ly, lx) else 0)
                self._rows.sort(key=functools.cmp_to_key(cmp), reverse=bool(order))
        self.modelReset.emit()

    invalidateFilter = invalidateRowsFilter = invalidate

    def setFilterFixedString(self, text):
        self._text = str(text)
        self.invalidate()

    setFilterWildcard = setFilterRegularExpression = setFilterFixedString

    def setFilterKeyColumn(self, col):
        self._key_col = col
        self.invalidate()

    def setFilterCaseSensitivity(self, cs):
        self._case = cs
        self.invalidate()

    setSortCaseSensitivity = setDynamicSortFilter = setSortRole = setFilterRole = setRecursiveFilteringEnabled = lambda self, *a: None

    def sort(self, column, order=0):
        self._sort = (column, int(order))
        self.invalidate()

    def rowCount(self, parent=None):
        return len(self._rows)

    def columnCount(self, parent=None):
        return self._source.columnCount() if self._source is not None else 0

    def mapToSource(self, index):
        if not index.isValid() or index.row() >= len(self._rows):
            return QModelIndex()
        return self._source.index(self._rows[index.row()], index.column())

    def mapFromSource(self, index):
        if index.isValid() and index.row() in self._rows:
            return self.index(self._rows.index(index.row()), index.column())
        return QModelIndex()

    def data(self, index, role=0):
        return self._source.data(self.mapToSource(index), role) if self._source is not None else None

    def setData(self, index, value, role=2):
        return self._source.setData(self.mapToSource(index), value, role) if self._source is not None else False

    def flags(self, index):
        return self._source.flags(self.mapToSource(index)) if self._source is not None else Qt.ItemFlag.NoItemFlags

    def headerData(self, section, orientation, role=0):
        return self._source.headerData(section, orientation, role) if self._source is not None else None


class QItemSelection(list):
    def indexes(self):
        return list(self)


class QItemSelectionModel(QObject):
    selectionChanged = Signal(object, object)
    currentChanged = Signal(object, object)
    currentRowChanged = Signal(object, object)

    class SelectionFlag(_Flag):
        NoUpdate = 0
        Clear = 1
        Select = 2
        Deselect = 4
        Toggle = 8
        Current = 16
        Rows = 32
        Columns = 64
        SelectCurrent = 18
        ClearAndSelect = 3

    Select, Clear, Rows, ClearAndSelect, Deselect = SelectionFlag.Select, SelectionFlag.Clear, SelectionFlag.Rows, SelectionFlag.ClearAndSelect, SelectionFlag.Deselect

    def __init__(self, model=None, parent=None):
        super().__init__(parent)
        self._model, self._rows, self._current = model, [], QModelIndex()

    def _set_rows(self, rows, current=None):
        old = self._current
        self._rows = list(rows)
        if current is not None:
            self._current = current
        self.selectionChanged.emit(QItemSelection(self.selectedIndexes()), QItemSelection())
        if current is not None and current != old:
            self.currentChanged.emit(current, old)
            self.currentRowChanged.emit(current, old)

    def selectedRows(self, column=0):
        return [self._model.index(r, column) for r in self._rows] if self._model is not None else []

    def selectedIndexes(self):
        if self._model is None:
            return []
        return [self._model.index(r, c) for r in self._rows for c in range(self._model.columnCount())]

    def hasSelection(self):
        return bool(self._rows)

    def isSelected(self, index):
        return index.row() in self._rows

    isRowSelected = lambda self, row, *a: row in self._rows

    def currentIndex(self):
        return self._current

    def setCurrentIndex(self, index, flags=None):
        self._set_rows([index.row()] if index.isValid() else [], index)

    def select(self, index, flags=None):
        rows = [i.row() for i in index] if isinstance(index, list) else ([index.row()] if index.isValid() else [])
        if flags is not None and int(flags) & 4:
            self._set_rows([r for r in self._rows if r not in rows])
        elif flags is not None and int(flags) & 1:
            self._set_rows(rows)
        else:
            self._set_rows(self._rows + [r for r in rows if r not in self._rows])

    def clearSelection(self):
        self._set_rows([])

    clear = reset = clearSelection
    selection = lambda self: QItemSelection(self.selectedIndexes())
    model = lambda self: self._model


# ----------------------------------------------------------------------------- small value types

class QUrl:
    def __init__(self, url=""):
        self._url = url._url if isinstance(url, QUrl) else str(url)

    @staticmethod
    def fromLocalFile(path):
        return QUrl("file://" + os.path.abspath(str(path)))

    @staticmethod
    def fromUserInput(text, *a):
        return QUrl(text)

    def toString(self, *a):
        return self._url

    url = toDisplayString = toString

    def toLocalFile(self):
        return self._url[7:] if self._url.startswith("file://") else ""

    def isLocalFile(self):
        return self._url.startswith("file://")

    def isValid(self):
        return bool(self._url)

    isEmpty = lambda self: not self._url

    def scheme(self):
        return self._url.split(":", 1)[0] if ":" in self._url else ""

    def host(self):
        from urllib.parse import urlparse
        return urlparse(self._url).hostname or ""

    def path(self):
        from urllib.parse import urlparse
        return urlparse(self._url).path

    def fileName(self):
        return os.path.basename(self.path())

    def __str__(self):
        return self._url

    def __eq__(self, o):
        return isinstance(o, QUrl) and o._url == self._url

    def __hash__(self):
        return hash(self._url)


class QLocale:
    class Language(enum.IntEnum):
        AnyLanguage = 0
        C = 1
        English = 75

    class Country(enum.IntEnum):
        AnyCountry = 0
        UnitedStates = 248

    English, C, UnitedStates = Language.English, Language.C, Country.UnitedStates

    def __init__(self, *a):
        pass

    @staticmethod
    def system():
        return QLocale()

    c = system

    @staticmethod
    def setDefault(*a):
        pass

    def name(self):
        return "en_US"

    bcp47Name = lambda self: "en"
    language = lambda self: QLocale.Language.English
    uiLanguages = lambda self: ["en-US"]
    decimalPoint = lambda self: "."
    groupSeparator = lambda self: ","

    def toString(self, v, *a):
        return str(v)

    def toDouble(self, s):
        try:
            return float(s), True
        except ValueError:
            return 0.0, False

    def toInt(self, s):
        try:
            return int(s), True
        except ValueError:
            return 0, False


class QDate:
    def __init__(self, y=0, m=0, d=0):
        self._d = (y, m, d)

    @staticmethod
    def currentDate():
        t = _time.localtime()
        return QDate(t.tm_year, t.tm_mon, t.tm_mday)

    year = lambda self: self._d[0]
    month = lambda self: self._d[1]
    day = lambda self: self._d[2]
    isValid = lambda self: self._d[0] > 0

    def toString(self, fmt=None):
        return "%04d-%02d-%02d" % self._d

    def toPython(self):
        import datetime
        return datetime.date(*self._d)


class QTime:
    def __init__(self, h=0, m=0, s=0, ms=0):
        self._t = (h, m, s)

    @staticmethod
    def currentTime():
        t = _time.localtime()
        return QTime(t.tm_hour, t.tm_min, t.tm_sec)

    hour = lambda self: self._t[0]
    minute = lambda self: self._t[1]
    second = lambda self: self._t[2]

    def toString(self, fmt=None):
        return "%02d:%02d:%02d" % self._t


class QDateTime:
    def __init__(self, *a):
        self._t = _time.time()

    @staticmethod
    def currentDateTime():
        return QDateTime()

    currentDateTimeUtc = currentDateTime

    @staticmethod
    def currentMSecsSinceEpoch():
        return int(_time.time() * 1000)

    @staticmethod
    def currentSecsSinceEpoch():
        return int(_time.time())

    def toString(self, fmt=None):
        return _time.strftime("%Y-%m-%d %H:%M:%S", _time.localtime(self._t))

    def toSecsSinceEpoch(self):
        return int(self._t)

    def toMSecsSinceEpoch(self):
        return int(self._t * 1000)

    def date(self):
        t = _time.localtime(self._t)
        return QDate(t.tm_year, t.tm_mon, t.tm_mday)

    def time(self):
        t = _time.localtime(self._t)
        return QTime(t.tm_hour, t.tm_min, t.tm_sec)

    def toPython(self):
        import datetime
        return datetime.datetime.fromtimestamp(self._t)


class QStandardPaths:
    class StandardLocation(enum.IntEnum):
        DesktopLocation = 0
        DocumentsLocation = 1
        FontsLocation = 2
        ApplicationsLocation = 3
        MusicLocation = 4
        MoviesLocation = 5
        PicturesLocation = 6
        TempLocation = 7
        HomeLocation = 8
        AppLocalDataLocation = 9
        CacheLocation = 10
        GenericDataLocation = 11
        RuntimeLocation = 12
        ConfigLocation = 13
        DownloadLocation = 14
        GenericCacheLocation = 15
        GenericConfigLocation = 16
        AppDataLocation = 17
        AppConfigLocation = 18

    @staticmethod
    def writableLocation(kind):
        home = os.path.expanduser("~")
        name = QStandardPaths.StandardLocation(int(kind)).name
        if name == "HomeLocation":
            return home
        if name == "TempLocation":
            import tempfile
            return tempfile.gettempdir()
        if name in ("DesktopLocation", "DocumentsLocation", "DownloadLocation", "PicturesLocation", "MusicLocation", "MoviesLocation"):
            return wx._out_dir() if hasattr(wx, "_out_dir") else home
        app = QCoreApplication.applicationName()
        base = os.path.join(home, ".cache" if "Cache" in name else (".config" if "Config" in name else os.path.join(".local", "share")))
        return os.path.join(base, app) if name.startswith("App") or name == "CacheLocation" else base

    @staticmethod
    def standardLocations(kind):
        return [QStandardPaths.writableLocation(kind)]

    @staticmethod
    def findExecutable(name, paths=None):
        return ""

    @staticmethod
    def locate(kind, name, *a):
        p = os.path.join(QStandardPaths.writableLocation(kind), name)
        return p if os.path.exists(p) else ""


for _m in QStandardPaths.StandardLocation:
    setattr(QStandardPaths, _m.name, _m)


class QSettings(QObject):
    """Settings kept in a JSON file under the plugin's own configuration folder."""

    class Format(enum.IntEnum):
        NativeFormat = 0
        IniFormat = 1

    class Scope(enum.IntEnum):
        UserScope = 0
        SystemScope = 1

    NativeFormat, IniFormat, UserScope, SystemScope = Format.NativeFormat, Format.IniFormat, Scope.UserScope, Scope.SystemScope

    def __init__(self, *a):
        super().__init__()
        names = [str(x) for x in a if isinstance(x, str)]
        if names and (os.sep in names[0] or names[0].endswith((".ini", ".conf", ".json"))):
            self._path = names[0]
        else:
            org = names[0] if names else (QCoreApplication.organizationName() or "plugin")
            app = names[1] if len(names) > 1 else QCoreApplication.applicationName()
            self._path = os.path.join(os.path.expanduser("~"), ".config", org, app + ".json")
        self._group = []
        self._data = {}
        try:
            import json
            with open(self._path, encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                self._data = d
        except (OSError, ValueError):
            pass

    def _key(self, key):
        return "/".join(self._group + [str(key)])

    def value(self, key, default=None, type=None):
        v = self._data.get(self._key(key), default)
        if type is not None and v is not None:
            try:
                if type is bool:
                    return v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes")
                return type(v)
            except (TypeError, ValueError):
                return default
        return v

    def setValue(self, key, value):
        try:
            import json
            json.dumps(value)
        except (TypeError, ValueError):
            value = str(value)
        self._data[self._key(key)] = value

    def contains(self, key):
        return self._key(key) in self._data

    def remove(self, key):
        k = self._key(key)
        for name in [n for n in self._data if n == k or n.startswith(k + "/")]:
            del self._data[name]

    def beginGroup(self, name):
        self._group.append(str(name))

    def endGroup(self):
        if self._group:
            self._group.pop()

    def allKeys(self):
        prefix = "/".join(self._group)
        return [k[len(prefix) + 1:] if prefix else k for k in self._data if not prefix or k.startswith(prefix + "/")]

    childKeys = allKeys

    def childGroups(self):
        return sorted({k.split("/")[0] for k in self.allKeys() if "/" in k})

    def clear(self):
        self._data = {}

    def sync(self):
        try:
            import json
            os.makedirs(os.path.dirname(self._path), exist_ok=True)
            with open(self._path, "w", encoding="utf-8") as f:
                json.dump(self._data, f)
        except OSError:
            pass

    def fileName(self):
        return self._path

    status = lambda self: 0

    def __del__(self):
        try:
            self.sync()
        except Exception:
            pass


class QEvent:
    class Type(enum.IntEnum):
        None_ = 0
        Timer = 1
        MouseButtonPress = 2
        MouseButtonRelease = 3
        MouseButtonDblClick = 4
        MouseMove = 5
        KeyPress = 6
        KeyRelease = 7
        FocusIn = 8
        FocusOut = 9
        Enter = 10
        Leave = 11
        Paint = 12
        Move = 13
        Resize = 14
        Show = 17
        Hide = 18
        Close = 19
        Wheel = 31
        WindowStateChange = 105
        LanguageChange = 89
        PaletteChange = 39
        StyleChange = 100
        ToolTip = 110
        ThemeChange = 210

    def __init__(self, kind=0):
        self._type, self._accepted = kind, True

    def type(self):
        return self._type

    def accept(self):
        self._accepted = True

    def ignore(self):
        self._accepted = False

    def isAccepted(self):
        return self._accepted

    def setAccepted(self, on):
        self._accepted = bool(on)

    spontaneous = lambda self: False


for _m in QEvent.Type:
    setattr(QEvent, _m.name, _m)


class QByteArray(bytes):
    def data(self):
        return bytes(self)

    def toBase64(self):
        import base64
        return QByteArray(base64.b64encode(self))

    @staticmethod
    def fromBase64(b):
        import base64
        return QByteArray(base64.b64decode(bytes(b)))

    def toHex(self):
        return QByteArray(self.hex().encode())

    isEmpty = lambda self: not self
    size = lambda self: len(self)


class QBuffer(QObject):
    def __init__(self, *a):
        super().__init__()
        self._data = b""

    def open(self, *a):
        return True

    def close(self):
        pass

    def data(self):
        return QByteArray(self._data)

    def write(self, b):
        self._data += bytes(b)
        return len(b)

    buffer = data


class QIODevice:
    class OpenModeFlag(_Flag):
        NotOpen = 0
        ReadOnly = 1
        WriteOnly = 2
        ReadWrite = 3
        Append = 4
        Truncate = 8
        Text = 16

    ReadOnly, WriteOnly, ReadWrite, Text, Append, Truncate = (OpenModeFlag.ReadOnly, OpenModeFlag.WriteOnly, OpenModeFlag.ReadWrite,
                                                             OpenModeFlag.Text, OpenModeFlag.Append, OpenModeFlag.Truncate)


class QFile(QObject):
    def __init__(self, name=""):
        super().__init__()
        self._name, self._f = str(name), None

    def open(self, mode=1):
        try:
            self._f = open(self._name, "rb" if int(mode) & 1 and not int(mode) & 2 else "wb")
            return True
        except OSError:
            return False

    def readAll(self):
        return QByteArray(self._f.read() if self._f else b"")

    def write(self, data):
        return self._f.write(bytes(data)) if self._f else -1

    def close(self):
        if self._f:
            self._f.close()
            self._f = None

    def exists(self=None, name=None):
        return os.path.exists(name if name is not None else (self._name if isinstance(self, QFile) else str(self)))

    fileName = lambda self: self._name


class QFileInfo:
    def __init__(self, path=""):
        self._p = str(path)

    exists = lambda self: os.path.exists(self._p)
    isFile = lambda self: os.path.isfile(self._p)
    isDir = lambda self: os.path.isdir(self._p)
    fileName = lambda self: os.path.basename(self._p)
    baseName = lambda self: os.path.basename(self._p).split(".")[0]
    completeBaseName = lambda self: os.path.splitext(os.path.basename(self._p))[0]
    suffix = lambda self: os.path.splitext(self._p)[1].lstrip(".")
    absolutePath = path = lambda self: os.path.dirname(os.path.abspath(self._p))
    absoluteFilePath = filePath = lambda self: os.path.abspath(self._p)
    size = lambda self: os.path.getsize(self._p) if os.path.exists(self._p) else 0


class QDir:
    def __init__(self, path="."):
        self._p = str(path)

    @staticmethod
    def homePath():
        return os.path.expanduser("~")

    @staticmethod
    def tempPath():
        import tempfile
        return tempfile.gettempdir()

    @staticmethod
    def currentPath():
        return os.getcwd()

    @staticmethod
    def toNativeSeparators(p):
        return str(p)

    fromNativeSeparators = cleanPath = toNativeSeparators

    @staticmethod
    def separator():
        return os.sep

    def path(self):
        return self._p

    absolutePath = lambda self: os.path.abspath(self._p)
    exists = lambda self, name=None: os.path.exists(os.path.join(self._p, name) if name else self._p)
    filePath = absoluteFilePath = lambda self, name: os.path.join(self._p, name)

    def mkpath(self, p):
        os.makedirs(p if os.path.isabs(p) else os.path.join(self._p, p), exist_ok=True)
        return True

    mkdir = mkpath

    def entryList(self, *a):
        try:
            return sorted(os.listdir(self._p))
        except OSError:
            return []


class QMimeData(QObject):
    def __init__(self):
        super().__init__()
        self._text = ""

    def setText(self, t):
        self._text = str(t)

    text = lambda self: self._text
    hasText = lambda self: bool(self._text)
    hasUrls = hasImage = hasHtml = lambda self: False
    urls = lambda self: []
    setData = setUrls = setHtml = lambda self, *a: None
    formats = lambda self: ["text/plain"] if self._text else []


class QTranslator(QObject):
    def load(self, *a):
        return False


class QLibraryInfo:
    @staticmethod
    def path(*a):
        return ""

    location = path


class QSysInfo:
    @staticmethod
    def productType():
        return "linux"

    prettyProductName = kernelType = productType


class QRegularExpression:
    def __init__(self, pattern="", *a):
        import re
        self._re = re.compile(str(pattern))

    def pattern(self):
        return self._re.pattern

    def match(self, text):
        return _ReMatch(self._re.search(str(text)))

    isValid = lambda self: True


class _ReMatch:
    def __init__(self, m):
        self._m = m

    hasMatch = lambda self: self._m is not None

    def captured(self, n=0):
        return (self._m.group(n) or "") if self._m else ""


class QProcess(QObject):
    """Starting another program: there are none in a browser, and a plugin is told so."""
    finished = Signal(int, int)
    errorOccurred = Signal(int)
    readyReadStandardOutput = Signal()
    readyReadStandardError = Signal()
    started = Signal()

    def start(self, program="", args=(), *a):
        import pcbnew
        raise pcbnew.WebUnsupported(f"Running another program ({os.path.basename(str(program)) or 'a command'}): there are no other programs in the browser")

    startDetached = execute = start
    waitForFinished = waitForStarted = lambda self, *a: False
    readAllStandardOutput = readAllStandardError = readAll = lambda self: QByteArray(b"")
    state = exitCode = lambda self: 0
    kill = terminate = close = setProgram = setArguments = setWorkingDirectory = setProcessChannelMode = setProcessEnvironment = lambda self, *a: None


def qInstallMessageHandler(*a):
    return None


def qDebug(*a):
    print(*a)


qWarning = qCritical = qInfo = qDebug


def QT_TRANSLATE_NOOP(context, text):
    return text


QT_TR_NOOP = lambda text: text
SIGNAL = SLOT = lambda s: s


class QOperatingSystemVersion:
    @staticmethod
    def current():
        return QOperatingSystemVersion()

    majorVersion = minorVersion = microVersion = lambda self: 0
    name = lambda self: "Linux"


class QLockFile:
    """A lock file in this interpreter's own file system.  Each plugin runs alone in its interpreter, so the lock is
    taken unless this same run already holds it."""
    NoError, LockFailedError, PermissionError, UnknownError = range(4)
    _held = {}

    def __init__(self, fileName=""):
        self._name, self._locked, self._error, self._stale = str(fileName), False, QLockFile.NoError, 30000

    def fileName(self):
        return self._name

    def setStaleLockTime(self, ms):
        self._stale = int(ms)

    def staleLockTime(self):
        return self._stale

    def tryLock(self, timeout=0):
        import os
        if self._locked:
            return True
        if QLockFile._held.get(self._name) is not None:
            self._error = QLockFile.LockFailedError
            return False
        try:
            d = os.path.dirname(self._name)
            if d:
                os.makedirs(d, exist_ok=True)
            with open(self._name, "w", encoding="utf-8") as fh:
                fh.write("%d\nweb\nkicad\n" % os.getpid())
        except OSError:
            self._error = QLockFile.PermissionError
            return False
        QLockFile._held[self._name] = self
        self._locked, self._error = True, QLockFile.NoError
        return True

    def lock(self):
        return self.tryLock(-1)

    def unlock(self):
        import os
        if self._locked:
            QLockFile._held.pop(self._name, None)
            self._locked = False
            try:
                os.remove(self._name)
            except OSError:
                pass

    def isLocked(self):
        return self._locked

    def error(self):
        return self._error

    def getLockInfo(self):
        import os
        try:
            with open(self._name, encoding="utf-8") as fh:
                pid, host, app = (fh.read().split("\n") + ["", "", ""])[:3]
            return (int(pid or 0), host, app)
        except (OSError, ValueError):
            return (os.getpid() if self._locked else 0, "web", "kicad")

    def removeStaleLockFile(self):
        import os
        if QLockFile._held.get(self._name) is None:
            try:
                os.remove(self._name)
                return True
            except OSError:
                return False
        return False


class QFileSystemWatcher(QObject):
    """Keeps the paths it is given.  Nothing outside the plugin changes files in its interpreter's file system, so the
    change signals have nothing to report."""
    fileChanged = Signal(str)
    directoryChanged = Signal(str)

    def __init__(self, paths=None, parent=None):
        if paths is not None and not isinstance(paths, (list, tuple)):
            paths, parent = None, paths
        QObject.__init__(self, parent)
        self._files, self._dirs = [], []
        if paths:
            self.addPaths(paths)

    def addPath(self, path):
        import os
        path = str(path)
        if not os.path.exists(path):
            return False
        box = self._dirs if os.path.isdir(path) else self._files
        if path in box:
            return False
        box.append(path)
        return True

    def addPaths(self, paths):
        return [p for p in paths if not self.addPath(p)]

    def removePath(self, path):
        for box in (self._files, self._dirs):
            if str(path) in box:
                box.remove(str(path))
                return True
        return False

    def removePaths(self, paths):
        return [p for p in paths if not self.removePath(p)]

    def files(self):
        return list(self._files)

    def directories(self):
        return list(self._dirs)
