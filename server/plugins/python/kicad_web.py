# kicad_web.py — runs KiCad's Python plugins inside the web editor's plugin sandbox.
#
# The sandbox frame (web/plugins/pyruntime.ts) starts Python, puts this folder on sys.path and
# calls boot() with the plugin's files.  From there this module does what KiCad does on the
# desktop: import the plugin package from the plugins folder, collect the ActionPlugins it
# registers, and call Run() when the person picks one.  Around Run() it does what the desktop
# cannot need: fetch the board from the editor, and send what the plugin changed back as one
# collaborative edit.
#
# `bridge` is the way out.  In the browser it is the `kicad` API of the sandbox (each call
# blocks the Python stack until the editor answers); the test harness passes a stand-in.

import base64
import re
import importlib
import importlib.abc
import importlib.machinery
import io
import json
import os
import sys
import threading
import traceback
import types
import zipfile

import logging

import pcbnew
import wx

log = logging.getLogger("kicad_web")

ROOT = os.environ.get("KICAD_WEB_ROOT", "/kicad")
PLUGIN_DIR = ROOT + "/3rdparty/plugins"
RESOURCE_DIR = ROOT + "/3rdparty/resources"
CONFIG_DIR = ROOT + "/config"
PROJECT_DIR = os.environ.get("KICAD_WEB_PROJECT", "/project")
UPLOAD_DIR = "/uploads"

_bridge = None
_plugin = {"identifier": "", "package": "", "name": ""}
_actions = []            # ActionPlugin objects, in registration order
_load_error = None
_running = [0]


# ----------------------------------------------------------------------------- wx submodules

_MIXIN_INIT = lambda self, *a, **k: None


def _wx_sub_attr(modname):
    def get(name):
        if name.startswith("__"):
            raise AttributeError(name)
        if hasattr(wx, name) and name not in wx._missing:
            return getattr(wx, name)
        if name not in ("NewEvent", "NewCommandEvent"):
            wx._missing.add(f"{modname}.{name}")
        if name.endswith("Mixin") or name.endswith("Mixins"):
            return type(name, (object,), {"__init__": _MIXIN_INIT})
        if name in ("NewEvent", "NewCommandEvent"):
            def new_event(*_a):
                binder = wx.PyEventBinder(f"EVT_CUSTOM_{wx.NewId()}", name == "NewCommandEvent")

                class _Custom(wx.Event):
                    def __init__(self, *a, **k):
                        wx.Event.__init__(self, None, binder, a[0] if a and isinstance(a[0], int) else None)
                        self.__dict__.update(k)
                return _Custom, binder
            return new_event
        return getattr(wx, name)
    return get


class _WxFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """`import wx.adv`, `wx.lib.agw.aui`, … : every wx submodule exists and stands in for what it holds."""

    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith("wx."):
            return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
        return None

    def create_module(self, spec):
        m = types.ModuleType(spec.name)
        m.__path__ = []
        m.__getattr__ = _wx_sub_attr(spec.name)
        return m

    def exec_module(self, module):
        name = module.__name__
        if name == "wx.lib.embeddedimage":
            class PyEmbeddedImage:
                def __init__(self, data, *a):
                    self._data = data

                def GetBitmap(self):
                    b = wx.Bitmap()
                    b._url = "data:image/png;base64," + (self._data.decode() if isinstance(self._data, bytes) else str(self._data))
                    return b

                Bitmap = property(GetBitmap)
                getBitmap = GetBitmap

                def GetIcon(self):
                    i = wx.Icon()
                    i._url = self.GetBitmap()._url
                    return i

                GetImage = lambda self: wx.Image(self.GetBitmap())
            module.PyEmbeddedImage = PyEmbeddedImage
        elif name in ("wx.lib.pubsub", "wx.lib.pubsub.pub"):
            from pubsub import pub
            if name.endswith(".pub"):
                for k, v in vars(pub).items():
                    if not k.startswith("__"):
                        setattr(module, k, v)
            else:
                module.pub = pub
                module.Publisher = pub.Publisher
        elif name == "wx.lib.colourutils":
            def AdjustAlpha(colour, alpha):
                return wx.Colour(colour.Red(), colour.Green(), colour.Blue(), alpha)

            def AdjustColour(color, percent, alpha=wx.ALPHA_OPAQUE):
                def adj(c):
                    end = 255 if percent > 0 else 0
                    return max(0, min(255, int(c + (end - c) * abs(percent) / 100.0)))
                return wx.Colour(adj(color.Red()), adj(color.Green()), adj(color.Blue()), alpha)

            def BestLabelColour(color, bw=False):
                avg = (color.Red() + color.Green() + color.Blue()) / 3
                if bw:
                    return wx.BLACK if avg > 128 else wx.WHITE
                return AdjustColour(color, -50 if avg > 128 else 50)

            def GetHighlightColour():
                return wx.SystemSettings.GetColour(wx.SYS_COLOUR_HIGHLIGHT)
            module.AdjustAlpha, module.AdjustColour, module.BestLabelColour, module.GetHighlightColour = AdjustAlpha, AdjustColour, BestLabelColour, GetHighlightColour
            module.__all__ = ["AdjustAlpha", "AdjustColour", "BestLabelColour", "GetHighlightColour"]
        elif name == "wx.lib.scrolledpanel":
            module.ScrolledPanel = wx.ScrolledWindow
        elif name == "wx.lib.wordwrap":
            def wordwrap(text, width, dc, breakLongWords=True, margin=0):
                """Break text into lines no wider than `width` in the font of `dc`."""
                out = []
                room = max(1, width - 2 * margin)
                wide = lambda t: dc.GetTextExtent(t)[0]
                for para in str(text).split("\n"):
                    line = ""
                    for word in para.split(" "):
                        trial = word if not line else line + " " + word
                        if wide(trial) <= room:
                            line = trial
                            continue
                        if line:
                            out.append(line)
                        line = word
                        while breakLongWords and len(line) > 1 and wide(line) > room:
                            cut = len(line) - 1
                            while cut > 1 and wide(line[:cut]) > room:
                                cut -= 1
                            out.append(line[:cut])
                            line = line[cut:]
                    out.append(line)
                return "\n".join(out)
            module.wordwrap = wordwrap
        elif name == "wx.lib.intctrl":
            class IntCtrl(wx.TextCtrl):
                def __init__(self, parent=None, id=wx.ID_ANY, value=0, *a, **k):
                    k = {x: v for x, v in k.items() if x in ("size", "style", "name", "pos")}
                    wx.TextCtrl.__init__(self, parent, id, str(value), **k)

                def GetValue(self):
                    try:
                        return int(float(wx.TextCtrl.GetValue(self)))
                    except ValueError:
                        return 0

                def SetValue(self, v):
                    wx.TextCtrl.SetValue(self, str(v))

                SetMin = SetMax = SetBounds = SetNoneAllowed = SetLimited = lambda self, *a: None
            module.IntCtrl = IntCtrl
        elif name == "wx.adv":
            class AboutDialogInfo:
                def __init__(self):
                    self._v = {}

                def __getattr__(self, n):
                    if n.startswith("Set"):
                        return lambda *a: self._v.__setitem__(n[3:], a[0] if a else None)
                    if n.startswith("Add"):
                        return lambda *a: self._v.setdefault(n[3:], []).append(a[0] if a else None)
                    raise AttributeError(n)

            def about(info, parent=None):
                v = info._v
                text = "\n".join(str(x) for x in (v.get("Version"), v.get("Description"), v.get("Copyright"), v.get("WebSite")) if x)
                wx.MessageBox(text, str(v.get("Name") or "About"))
            module.AboutDialogInfo = AboutDialogInfo
            module.AboutBox = about
            module.GenericAboutBox = about
            module.HyperlinkCtrl = wx.HyperlinkCtrl
            module.EVT_HYPERLINK = wx.EVT_HYPERLINK
            module.HL_DEFAULT_STYLE = 0
        elif name == "wx.lib.buttons":       # the "generic" buttons wxPython draws itself: here they are the ordinary ones
            class GenButton(wx.Button):
                SetBezelWidth = SetUseFocusIndicator = SetInitialSize = lambda self, *a, **k: None

            class GenBitmapButton(wx.BitmapButton):
                SetBezelWidth = SetUseFocusIndicator = SetInitialSize = lambda self, *a, **k: None

            class GenToggleButton(wx.ToggleButton):
                SetBezelWidth = SetUseFocusIndicator = SetInitialSize = lambda self, *a, **k: None
                GetToggle = lambda self: self.GetValue()
                SetToggle = lambda self, on: self.SetValue(on)

            class GenBitmapTextButton(GenButton):
                def __init__(self, parent=None, id=-1, bitmap=None, label="", *a, **k):
                    super().__init__(parent, id, label, *a, **k)
                    if bitmap is not None:
                        self.SetBitmap(bitmap)

            module.GenButton = module.ThemedGenButton = GenButton
            module.GenBitmapButton = module.ThemedGenBitmapButton = GenBitmapButton
            module.GenToggleButton = module.ThemedGenToggleButton = GenToggleButton
            module.GenBitmapToggleButton = module.ThemedGenBitmapToggleButton = GenToggleButton
            module.GenBitmapTextButton = module.ThemedGenBitmapTextButton = GenBitmapTextButton
            module.GenBitmapTextToggleButton = module.ThemedGenBitmapTextToggleButton = GenToggleButton
        elif name.startswith("wx.lib.agw.persist"):
            _persist_module(module)
        elif name == "wx.xrc":
            def no_xrc(*a, **k):
                raise pcbnew.WebUnsupported("Dialogs loaded from XRC resource files are not available in the web editor")
            module.XRCCTRL = no_xrc
            module.XRCID = lambda name: wx.NewId()

            class XmlResource:
                def __init__(self, *a, **k):
                    pass

                Get = staticmethod(lambda: XmlResource())
                Load = LoadFile = InitAllHandlers = AddHandler = lambda self, *a: True
                LoadDialog = LoadFrame = LoadPanel = LoadObject = LoadMenu = lambda self, *a, **k: no_xrc()
            module.XmlResource = XmlResource
            module.EmptyXmlResource = XmlResource
            module.XRC_USE_LOCALE = module.XRC_NO_SUBCLASSING = 0


class _Persistence:
    """wx.lib.agw.persist: a dialog's values are kept in a settings file and put back the next time it opens."""
    _one = None

    def __init__(self):
        self._file = None
        self._objects = {}          # window -> PersistentObject

    @classmethod
    def Get(cls):
        if cls._one is None:
            cls._one = cls()
        return cls._one

    @classmethod
    def Free(cls):
        cls._one = None

    def SetPersistenceFile(self, path):
        self._file = str(path)

    def GetPersistenceFile(self):
        return self._file or os.path.join(CONFIG_DIR, "persist.cfg")

    def GetPersistenceDirectory(self):
        return os.path.dirname(self.GetPersistenceFile())

    def SetManagerStyle(self, *_):
        pass

    GetManagerStyle = lambda self: 0
    SetConfigurationHandler = lambda self, *_: None
    GetConfigurationHandler = lambda self: None

    def _read(self):
        try:
            with open(self.GetPersistenceFile(), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self, data):
        try:
            os.makedirs(self.GetPersistenceDirectory(), exist_ok=True)
            with open(self.GetPersistenceFile(), "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=1, sort_keys=True)
        except OSError:
            log.warning("the dialog's values could not be saved to %s", self.GetPersistenceFile())

    @staticmethod
    def _key(window):
        return "%s/%s" % (type(window).__name__, window.GetName())

    @staticmethod
    def _value_of(window):
        for getter in ("GetValue", "GetSelection", "GetPath", "GetStringSelection"):
            f = getattr(type(window), getter, None)
            if f is not None:
                try:
                    v = f(window)
                except Exception:
                    continue
                if isinstance(v, (bool, int, float, str)):
                    return {"get": getter, "value": v}
        return None

    def Find(self, window):
        return self._objects.get(window)

    def Register(self, window, persistenceHandler=None):
        if window in self._objects:
            return False
        obj = window if isinstance(window, _PersistentObject) else _PersistentObject(window, persistenceHandler)
        self._objects[window] = obj
        return True

    def Unregister(self, window):
        return self._objects.pop(window, None) is not None

    def Save(self, window):
        if window not in self._objects:
            return False
        v = self._value_of(window)
        if v is None or not window.GetName():
            return False
        data = self._read()
        data[self._key(window)] = v
        self._write(data)
        return True

    def Restore(self, window):
        if window not in self._objects:
            return False
        v = self._read().get(self._key(window))
        if not isinstance(v, dict) or "value" not in v:
            return False
        setter = getattr(window, "Set" + str(v.get("get", "GetValue"))[3:], None)
        try:
            setter(v["value"])
        except Exception:
            return False
        return True

    def RegisterAndRestore(self, window):
        return self.Register(window) and self.Restore(window)

    def SaveAndUnregister(self, window=None):
        if window is None:
            data = self._read()
            for w in list(self._objects):
                v = self._value_of(w)
                if v is not None and w.GetName():
                    data[self._key(w)] = v
            self._write(data)
            self._objects.clear()
            return True
        ok = self.Save(window)
        self.Unregister(window)
        return ok

    def _named(self, window):
        # what a person would expect to come back: the fields they filled in, not labels or buttons
        out = []
        for c in getattr(window, "_wx_children", []):
            if c is window:
                continue
            if isinstance(c, _PersistentObject) or (c.GetName() and self._value_of(c) is not None and not isinstance(c, (wx.StaticText, wx.Button))):
                out.append(c)
            out.extend(self._named(c))
        return out

    def RegisterAndRestoreAll(self, window, children=True):
        ok = False
        for c in self._named(window) if children else [window]:
            self.Register(c)
            ok = self.Restore(c) or ok
        return ok

    def SaveValue(self, obj, name, value):
        data = self._read()
        data["%s/%s" % (self._key(obj.GetWindow()), name)] = {"value": value}
        self._write(data)
        return True

    def RestoreValue(self, obj, name):
        v = self._read().get("%s/%s" % (self._key(obj.GetWindow()), name))
        return v.get("value") if isinstance(v, dict) else None

    DisableSaving = DisableRestoring = EnableSaving = EnableRestoring = lambda self, *_: None


class _PersistentObject:
    def __init__(self, window, persistenceHandler=None):
        self._window = window
        self._persistentHandler = persistenceHandler

    def GetWindow(self):
        return self._window

    def GetName(self):
        return self._window.GetName()

    def GetKind(self):
        return type(self._window).__name__

    def Save(self):
        return _Persistence.Get().Save(self._window)

    def Restore(self):
        return _Persistence.Get().Restore(self._window)

    def SaveValue(self, name, value):
        return _Persistence.Get().SaveValue(self, name, value)

    SaveCtrlValue = SaveValue

    def RestoreValue(self, name):
        return _Persistence.Get().RestoreValue(self, name)

    RestoreCtrlValue = RestoreValue


def _persist_module(module):
    module.PersistenceManager = _Persistence
    module.PersistentObject = _PersistentObject
    module.PersistentHandler = module.AbstractHandler = type("AbstractHandler", (), {"__init__": lambda self, *a, **k: None})
    for kind in ("Spin", "TextCtrl", "CheckBox", "Choice", "ComboBox", "Slider", "RadioBox", "RadioButton", "ListBox", "CheckListBox", "TLW", "Book", "TreeCtrl",
                 "ListCtrl", "ToggleButton", "FilePicker", "DirPicker", "ColourPicker", "FontPicker", "SearchCtrl", "Gauge", "SplitterWindow", "Menu", "ToolBar"):
        setattr(module, kind + "Handler", type(kind + "Handler", (module.AbstractHandler,), {}))
    for i, flag in enumerate(("PM_SAVE_RESTORE_AUI_PERSPECTIVES", "PM_SAVE_RESTORE_TREE_LIST_SELECTIONS", "PM_PERSIST_CONTROL_VALUE", "PM_RESTORE_CAPTION_FROM_CODE", "PM_DEFAULT_STYLE")):
        setattr(module, flag, 1 << i)
    from importlib import import_module
    if module.__name__ == "wx.lib.agw.persist":
        module.persistencemanager = import_module("wx.lib.agw.persist.persistencemanager")
        module.persist_handlers = import_module("wx.lib.agw.persist.persist_handlers")


class _OwnNameFinder(importlib.abc.MetaPathFinder):
    """A plugin that imports itself by the folder name its author had it under (`from KLEPlacement.parser import X`).
    KiCad's plugin manager installs it under its package identifier instead, so that name finds nothing; here it is the
    plugin's own package.  Only a name that matches the plugin's own name is answered, and only when nothing else did."""

    @staticmethod
    def _norm(text):
        return "".join(c for c in str(text).lower() if c.isalnum())

    def find_spec(self, fullname, path=None, target=None):
        pkg = _plugin.get("package")
        if not pkg or "." in fullname or fullname == pkg or pkg not in sys.modules:
            return None
        want = self._norm(fullname)
        own = {self._norm(_plugin.get("name")), self._norm(str(_plugin.get("identifier")).rsplit(".", 1)[-1])}
        if not want or want not in own:
            return None
        sys.modules[fullname] = sys.modules[pkg]          # the same module object: its submodules are found through its __path__
        return sys.modules[pkg].__spec__


def _install_finders():
    if not any(isinstance(f, _WxFinder) for f in sys.meta_path):
        sys.meta_path.append(_WxFinder())
    if not any(isinstance(f, _OwnNameFinder) for f in sys.meta_path):
        sys.meta_path.append(_OwnNameFinder())
    import kicad_compat
    kicad_compat.install()


# ----------------------------------------------------------------------------- the environment a plugin expects

class _Parked(BaseException):
    """Raised inside a "thread" that turned out to be a loop which only waits: it is set aside."""


_threads = []          # sleep budgets of the threads running now, innermost last
_thread_objs = []      # and the thread objects themselves


def run_thread(thread, fn):
    """Run a thread's work now, on this stack.  Returns "done", or "waiting" when it was set aside at a queue it reads
    its jobs from (it goes on when a job arrives), or "parked" when it only sleeps and looks."""
    thread._kc_alive = True
    _threads.append([0, 0.0])
    _thread_objs.append(thread)
    state = "done"
    try:
        fn()
    except _Parked as e:
        state = "waiting" if e.args and e.args[0] == "queue" else "parked"
        if state == "parked":
            log.debug("a background thread that only waits was set aside")
    except Exception:
        traceback.print_exc()
    finally:
        _threads.pop()
        _thread_objs.pop()
        thread._kc_alive = state == "waiting"
    done = getattr(thread, "_kc_done", None)
    if state == "done" and callable(done):
        done()
    return state


def _patch_threads():
    """There are no threads in the browser's Python: a thread a plugin starts runs to its end at once.

    A thread that is a watcher (a loop of sleep, look, sleep) would never end, so one that has slept
    a few seconds' worth without finishing is set aside: what it watches for (a download folder,
    another program) does not happen here."""
    def start(self):
        # Thread.run forgets its target when it returns; a thread that is set aside and picked up again needs it.
        self._kc_target = (getattr(self, "_target", None), getattr(self, "_args", ()), getattr(self, "_kwargs", {}))
        run_thread(self, lambda: again(self))

    def again(thread):
        saved = getattr(thread, "_kc_target", None)
        if saved is not None and not hasattr(thread, "_target"):
            thread._target, thread._args, thread._kwargs = saved
        thread.run()

    # A worker thread that takes its jobs from a queue: it runs until the queue is empty, is set aside there, and is
    # picked up again when a job is put in (after the code that put it has finished what it was doing).
    import queue
    real_get, real_put = queue.Queue.get, queue.Queue.put

    def q_get(self, block=True, timeout=None):
        if block and not self.qsize():
            if _thread_objs:
                waiting = self.__dict__.setdefault("_kc_waiters", [])
                if _thread_objs[-1] not in waiting:
                    waiting.append(_thread_objs[-1])
                raise _Parked("queue")
            if timeout is None:
                raise queue.Empty()             # nothing else runs that could put something in
        return real_get(self, block and bool(self.qsize()), timeout)

    def q_put(self, item, block=True, timeout=None):
        real_put(self, item, False)
        waiting = self.__dict__.get("_kc_waiters")
        if waiting:
            worker = waiting.pop(0)
            wx.CallAfter(lambda: run_thread(worker, lambda: again(worker)))

    # A thread that listens on a local port: it is set aside in accept() and given its turn when code of this
    # interpreter connects and waits for the answer (kicad_net).
    import kicad_net

    def park_listener(listener):
        if _thread_objs:
            listener._kc_thread = _thread_objs[-1]
            raise _Parked("queue")

    def serve_listener(listener):
        worker = getattr(listener, "_kc_thread", None)
        if worker is None or worker in _thread_objs:
            return
        listener._kc_thread = None
        run_thread(worker, lambda: again(worker))

    kicad_net.park = park_listener
    kicad_net.serve = serve_listener

    queue.Queue.get = q_get
    queue.Queue.put = q_put
    queue.Queue.put_nowait = lambda self, item: q_put(self, item)
    queue.Queue.join = lambda self: None

    def timer_start(self):
        # threading.Timer: "call this in a while".  In the browser that is a timeout; without one, now.
        if wx._DOM:
            def fire():
                if not self.finished.is_set():
                    self.function(*self.args, **self.kwargs)
                    self.finished.set()
            wx._kc().later(wx._once(lambda: wx._call(fire)), int(max(0.0, float(self.interval)) * 1000))
            return
        start(self)

    def timer_run(self):
        if not self.finished.is_set():
            self.function(*self.args, **self.kwargs)
        self.finished.set()

    # A pool of worker threads: each job runs where it is submitted, and its future is already done when it is handed back.
    import concurrent.futures as cf
    import concurrent.futures.thread as cft

    class _NowExecutor(cf.Executor):
        def __init__(self, max_workers=None, *a, **k):
            self._max_workers = max_workers or 1
            self._kc_down = False
            init = k.get("initializer")
            if callable(init):
                init(*k.get("initargs", ()))

        def submit(self, fn, /, *a, **k):
            if self._kc_down:
                raise RuntimeError("cannot schedule new futures after shutdown")
            f = cf.Future()
            f.set_running_or_notify_cancel()
            try:
                f.set_result(fn(*a, **k))
            except BaseException as e:          # the caller gets it from future.result(), as with a real pool
                if isinstance(e, (_Parked, KeyboardInterrupt, SystemExit)):
                    raise
                f.set_exception(e)
            return f

        def shutdown(self, wait=True, *, cancel_futures=False):
            self._kc_down = True

    cf.ThreadPoolExecutor = cft.ThreadPoolExecutor = _NowExecutor
    cf.ProcessPoolExecutor = _NowExecutor
    try:
        import concurrent.futures.process as cfp
        cfp.ProcessPoolExecutor = _NowExecutor
    except Exception:
        pass
    threading.Timer.start = timer_start
    threading.Timer.run = timer_run
    def event_wait(self, timeout=None):
        """Nothing else runs while this code runs.  What can still set the event is work handed to the window system
        (wx.CallAfter, a timer, the person's click): in the browser that gets its turn here, until the time is up."""
        if self.is_set() or not wx._DOM:
            return self.is_set()
        import time
        end = time.monotonic() + (float(timeout) if timeout is not None else 600.0)
        try:
            while not self.is_set() and time.monotonic() < end:
                wx._wait(wx._kc().sleep(15))
        except Exception:
            pass                    # this stack cannot be suspended: the answer is what it is now
        return self.is_set()

    threading.Event.wait = event_wait
    threading.Thread.start = start
    threading.Thread.join = lambda self, timeout=None: None
    threading.Thread.is_alive = lambda self: getattr(self, "_kc_alive", False)
    threading.Thread.isAlive = threading.Thread.is_alive
    import time
    real = time.sleep

    def sleep(seconds):
        if _threads:
            b = _threads[-1]
            b[0] += 1
            b[1] += max(0.0, float(seconds or 0))
            if b[0] >= 4 and b[1] >= 1.5:
                raise _Parked()
            return real(min(float(seconds or 0), 0.05))     # nothing else runs meanwhile: there is nothing to wait for
        return real(seconds)

    time.sleep = sleep


_OPENERS = ("xdg-open", "open", "explorer", "explorer.exe", "start", "gio", "nautilus", "dolphin", "thunar", "gnome-open", "kde-open", "cmd", "cmd.exe")


def _open_target(target):
    """A plugin asked the desktop to open something.  A web address is offered to the person as a link; a folder or a
    file of this interpreter needs no opening, because what the plugin wrote there is handed over as a download."""
    t = str(target or "")
    if t.startswith(("http://", "https://")):
        try:
            return bool(_call("ui.openLink", {"url": t}))
        except Exception:
            return False
    return True


def _patch_desktop():
    """Opening a browser, a file manager or another program: what the desktop does with those, done the web's way."""
    import subprocess
    import webbrowser
    webbrowser.open = lambda url, new=0, autoraise=True: _open_target(url)
    webbrowser.open_new = webbrowser.open_new_tab = lambda url: _open_target(url)
    os.startfile = lambda path, *a, **k: _open_target(path)

    def program(args):
        if isinstance(args, (list, tuple)):
            return os.path.basename(str(args[0])).lower() if args else "", [str(a) for a in args[1:]]
        import shlex
        try:
            parts = shlex.split(str(args))
        except ValueError:
            parts = str(args).split()
        return (os.path.basename(parts[0]).lower() if parts else ""), parts[1:]

    class Done:
        def __init__(self, args):
            self.args, self.returncode, self.stdout, self.stderr, self.pid = args, 0, b"", b"", 0

        def communicate(self, *a, **k):
            return self.stdout, self.stderr

        def wait(self, *a, **k):
            return self.returncode

        def poll(self):
            return self.returncode

        def kill(self):
            pass

        terminate = kill

        def check_returncode(self):
            if self.returncode:
                raise subprocess.CalledProcessError(self.returncode, self.args, self.stdout, self.stderr)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def python(args, rest, k):
        """A plugin starting Python on one of its own files: there is one interpreter here, so it runs in it."""
        import runpy
        while rest and rest[0] in ("-u", "-I", "-E", "-s", "-S", "-B", "-O", "-OO", "-X", "-W"):
            rest = rest[2:] if rest[0] in ("-X", "-W") else rest[1:]
        if not rest:
            raise pcbnew.WebUnsupported("Starting an interactive Python: there is no terminal in the browser")
        done = Done(args)
        argv, path, out, err = sys.argv, list(sys.path), sys.stdout, sys.stderr
        capture = k.get("capture_output") or k.get("stdout") == subprocess.PIPE
        buf, ebuf = io.StringIO(), io.StringIO()
        if capture:
            sys.stdout = buf
        if k.get("stderr") == subprocess.STDOUT and capture:
            sys.stderr = buf
        elif k.get("capture_output") or k.get("stderr") == subprocess.PIPE:
            sys.stderr = ebuf
        cwd = os.getcwd()
        environ = dict(os.environ)
        try:
            if k.get("cwd"):
                os.chdir(str(k["cwd"]))
            if isinstance(k.get("env"), dict):
                os.environ.update({str(a): str(b) for a, b in k["env"].items()})
            if rest[0] == "-m" and len(rest) > 1:
                sys.argv = [rest[1]] + rest[2:]
                runpy.run_module(rest[1], run_name="__main__", alter_sys=True)
            elif rest[0] == "-c" and len(rest) > 1:
                sys.argv = ["-c"] + rest[2:]
                exec(compile(rest[1], "<string>", "exec"), {"__name__": "__main__"})
            else:
                sys.argv = rest
                sys.path.insert(0, os.path.dirname(os.path.abspath(rest[0])))
                runpy.run_path(rest[0], run_name="__main__")
        except SystemExit as e:
            done.returncode = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
        finally:
            sys.argv, sys.path[:], sys.stdout, sys.stderr = argv, path, out, err
            for name in [n for n in os.environ if n not in environ]:          # the other program's environment ends with it
                del os.environ[name]
            os.environ.update(environ)
            try:
                os.chdir(cwd)
            except OSError:
                pass
        text = buf.getvalue()
        as_text = bool(k.get("text") or k.get("universal_newlines") or k.get("encoding"))
        done.stdout = text if as_text else text.encode("utf-8")
        done.stderr = ebuf.getvalue() if as_text else ebuf.getvalue().encode("utf-8")
        if k.get("check") and done.returncode:
            raise subprocess.CalledProcessError(done.returncode, args)
        return done

    def launch(args, *a, **k):
        name, rest = program(args)
        first = str(args[0]) if isinstance(args, (list, tuple)) and args else ""
        if (first and first == sys.executable) or name.startswith("python"):
            return python(args, rest, k)
        if name in _OPENERS:
            for r in rest:
                if not r.startswith(("-", "/c", "/C")) and r not in ('""',):
                    _open_target(r)
                    break
            return Done(args)
        import kicad_programs
        res = kicad_programs.run(name, rest, k.get("cwd"))     # kicad-cli and git: the editor answers for them
        if res is not None:
            done = Done(args)
            done.returncode = res.code
            text = bool(k.get("text") or k.get("universal_newlines") or k.get("encoding"))
            merged = k.get("stderr") == subprocess.STDOUT
            out, err = (res.out + res.err, "") if merged else (res.out, res.err)
            captured = k.get("capture_output") or k.get("stdout") in (subprocess.PIPE, subprocess.DEVNULL)
            if not captured and hasattr(k.get("stdout"), "write"):
                k["stdout"].write(out if "b" not in getattr(k["stdout"], "mode", "w") else out.encode("utf-8"))
            if hasattr(k.get("stderr"), "write"):
                k["stderr"].write(err if "b" not in getattr(k["stderr"], "mode", "w") else err.encode("utf-8"))
            for line in err.splitlines():
                log.warning("%s: %s", name, line)
            done.stdout = out if text else out.encode("utf-8")
            done.stderr = err if text else err.encode("utf-8")
            if k.get("check") and done.returncode:
                raise subprocess.CalledProcessError(done.returncode, args, done.stdout, done.stderr)
            return done
        raise pcbnew.WebUnsupported(f"Running another program ({name or 'a command'}): there are no other programs in the browser")

    def popen(args, *a, **k):
        """Popen's result is read through streams (proc.stdout.read()), run()'s through strings."""
        done = launch(args, *a, **k)
        for attr in ("stdout", "stderr"):
            v = getattr(done, attr)
            setattr(done, "_" + attr, v)
            piped = k.get(attr) == subprocess.PIPE
            setattr(done, attr, (io.StringIO(v) if isinstance(v, str) else io.BytesIO(v or b"")) if piped else None)
        done.stdin = io.BytesIO() if k.get("stdin") == subprocess.PIPE else None
        done.communicate = lambda *x, **y: (done._stdout if k.get("stdout") == subprocess.PIPE else None, done._stderr if k.get("stderr") == subprocess.PIPE else None)
        return done

    # The two programs the editor answers for are "installed": plugins look for them before they run them.
    import shutil
    real_which = shutil.which

    def which(cmd, *a, **k):
        import kicad_programs
        return kicad_programs.which(cmd) or real_which(cmd, *a, **k)

    shutil.which = which
    # KiCad ships its own Python two folders above pcbnew; plugins that start a second program look for it there.
    try:
        beside = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(pcbnew.__file__))))
    except Exception:
        beside = "/usr/bin"
    for stub in ("/usr/bin/kicad-cli", "/usr/bin/git", "/usr/bin/ffmpeg", "/usr/bin/ngspice", "/usr/bin/python3", "/usr/bin/python", os.path.join(beside, "python3")):
        try:
            if not os.path.exists(stub):
                _write(stub, b"#!/bin/sh\n")
                os.chmod(stub, 0o755)
        except OSError:
            pass

    # ngspice is the simulator in this page, as a program and as the library ctypes loads; a child process is the
    # plugin's own function running beside the rest (kicad_spice, kicad_process).
    try:
        import kicad_spice
        import kicad_process
        kicad_spice.install()
        kicad_process.install()
    except Exception:
        log.debug("ngspice and child processes are not set up", exc_info=True)

    # Nothing outside this interpreter can connect to it.  A plugin's own parts can (kicad_net: a listening socket and
    # a connection to it are two ends here); a server that serves files to another program or a browser page cannot.
    import socketserver

    def no_serve(self, *a, **k):
        raise pcbnew.WebUnsupported("Serving files to another program over a local network port")

    socketserver.BaseServer.serve_forever = no_serve
    socketserver.BaseServer.handle_request = no_serve

    def leave(code=0):
        """os._exit ends the whole program at once; here that program is the editor's interpreter, which other
        plugins share, so only the code that asked is ended."""
        raise SystemExit(code)

    os._exit = leave
    subprocess.Popen = popen
    subprocess.run = launch
    subprocess.call = lambda args, *a, **k: launch(args, **k).returncode
    subprocess.check_call = lambda args, *a, **k: launch(args, check=True, **k).returncode
    subprocess.check_output = lambda args, *a, **k: launch(args, capture_output=True, check=True, **k).stdout
    subprocess.getoutput = lambda cmd, *a, **k: ""
    subprocess.getstatusoutput = lambda cmd, *a, **k: (1, "")
    os.system = lambda cmd: subprocess.call(cmd)
    os.popen = lambda cmd, *a, **k: io.StringIO("")


def _patch_platform():
    """Plugins choose paths and programs by operating system; this interpreter's own name ("emscripten") is none they know
    and sends them down their Windows branch.  They are told Linux, which is what its file system looks like."""
    import platform
    import subprocess, tempfile, shutil, pathlib, zipfile, socket, selectors, locale, signal, time, glob, getpass, webbrowser      # noqa: F401,E401  (read the real platform first)
    for mod in ("asyncio", "ssl", "urllib.request", "http.client", "ctypes", "multiprocessing", "uuid", "mimetypes"):
        try:
            importlib.import_module(mod)
        except Exception:
            pass
    # sysconfig finds its build data by the platform's name: read it while the name is still the real one
    # (scipy asks for a build variable when it is imported, and fails as "broken install" otherwise)
    try:
        import sysconfig
        sysconfig.get_config_vars()
    except Exception:
        pass
    sys.platform = "linux"
    sys.executable = "/usr/bin/python3"
    sys._base_executable = sys.executable  # tools are looked for beside the interpreter, as in a KiCad install
    os.environ.setdefault("PATH", "/usr/bin")
    platform.system = lambda: "Linux"
    platform.platform = lambda *a, **k: "Linux-web-x86_64"
    platform.machine = lambda: "x86_64"
    platform.release = lambda: "web"
    platform.node = lambda: "web"
    platform.uname = lambda: type("uname_result", (tuple,), {"system": "Linux", "node": "web", "release": "web", "version": "web", "machine": "x86_64", "processor": ""})(("Linux", "web", "web", "web", "x86_64", ""))
    getpass.getuser = lambda: "kicad"
    os.environ.setdefault("USER", "kicad")
    os.environ.setdefault("LANG", "en_US.UTF-8")


def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


def _decode(body):
    if isinstance(body, str) and body.startswith("base64:"):
        return base64.b64decode(body[7:])
    return body.encode("utf-8") if isinstance(body, str) else bytes(body)


def package_name(identifier):
    return "".join(c if c.isalnum() else "_" for c in identifier)


def install_files(identifier, files):
    """Lay a PCM package out the way KiCad installs it: plugins/ becomes 3rdparty/plugins/<identifier>/."""
    pkg = package_name(identifier)
    for path, body in files.items():
        if path.startswith("plugins/"):
            _write(f"{PLUGIN_DIR}/{pkg}/{path[8:]}", _decode(body))
        elif path.startswith("resources/"):
            _write(f"{RESOURCE_DIR}/{pkg}/{path[10:]}", _decode(body))
        elif path == "metadata.json":
            _write(f"{PLUGIN_DIR}/{pkg}/../../metadata/{pkg}.json", _decode(body))
    return pkg


def _prefer_runtime_binaries(base):
    """A plugin's compiled core that the runtime carries built for the browser is imported before the plugin starts.

    Such a plugin ships the core as machine code for Windows, macOS and Linux and puts its folder on the path; none of
    those files can load here, and one of them would hide the module that can.  Importing the runtime's own build first
    keeps it: Python then hands that module to every later `import` of the name."""
    import importlib
    import importlib.util
    import re
    names = set()
    for _root, _dirs, files in os.walk(base):
        for f in files:
            m = re.match(r"^([A-Za-z_]\w*)[-.].*\.(?:so|pyd|dylib)$", f)
            if m:
                names.add(m.group(1))
    for name in sorted(names):
        if name in sys.modules:
            continue
        try:
            spec = importlib.util.find_spec(name)
            if spec is not None and "site-packages" in str(spec.origin or ""):
                importlib.import_module(name)
        except Exception as e:
            log.warning("the runtime's build of %s did not load: %s", name, e)


_IMPORT = __import__("re").compile(r"^[ \t]*(?:import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)|from[ \t]+([\w.]+)[ \t]+import)", __import__("re").M)


def needed_packages(files, lock):
    """Which of the runtime's optional packages (numpy, requests, kipy, …) this plugin imports.

    `files` are the package's files, `lock` the runtime's package list (pyodide-lock.json, as
    text).  A module the plugin brings itself is its own business and is left alone.  JSON list.
    """
    try:
        packages = (json.loads(lock) or {}).get("packages") or {}
    except ValueError:
        packages = {}
    by_import = {}
    for name, entry in packages.items():
        for imp in entry.get("imports") or []:
            by_import.setdefault(str(imp).split(".")[0], name)
    local, wanted = set(), set()
    for path in files:
        parts = str(path).split("/")
        if parts[0] != "plugins":
            continue
        for part in parts[1:-1]:
            local.add(part)
        if parts[-1].endswith(".py"):
            local.add(parts[-1][:-3])
    for path, body in files.items():
        if not str(path).endswith(".py") or not isinstance(body, str) or body.startswith("base64:"):
            continue
        for m in _IMPORT.finditer(body):
            for name in (m.group(1) or m.group(2) or "").split(","):
                top = name.strip().split(".")[0]
                if top and top not in local and top in by_import:
                    wanted.add(by_import[top])
    # polygon set operations of pcbnew (Inflate, BooleanSubtract, …) are done with shapely
    if "shapely" in packages and any(isinstance(body, str) and str(path).endswith(".py") and (_CLIPPER.search(body) or "import pyclipper" in body) for path, body in files.items()):
        wanted.add("shapely")
    # a package's own requirements come first (shapely needs numpy)
    out, seen = [], set()

    def add(name):
        if name in seen or name not in packages:
            return
        seen.add(name)
        for dep in packages[name].get("depends") or []:
            add(dep)
        out.append(name)
    for name in sorted(wanted):
        add(name)
    return json.dumps(out)


_CLIPPER = __import__("re").compile(r"\.(Inflate|Deflate|InflateWithLinkedHoles|BooleanAdd|BooleanSubtract|BooleanIntersection|BooleanXor|TransformShapeToPolygon|TransformShapeWithClearanceToPolygon|GetEffectiveShape|GetBoardPolygonOutlines|Collide|refill_zones)\s*\(|\b(ZONE_FILLER|SHAPE_CIRCLE|SHAPE_SEGMENT|SHAPE_RECT)\b|--refill-zones|\bRefillZones\b|ZONE_FILL\b")


def _on_register(plugin):
    if plugin not in _actions:
        _actions.append(plugin)


def _on_register_wizard(wizard):
    """A footprint wizard: offered as a command that opens the wizard dialog (kicad_wizard.py)."""
    import kicad_wizard
    if not any(isinstance(x, kicad_wizard.WizardAction) and type(x.wizard) is type(wizard) for x in _actions):
        _actions.append(kicad_wizard.WizardAction(wizard))


def boot(identifier, files, bridge=None, name=""):
    """Install the plugin's files and import it.  Returns what it registered, as JSON."""
    global _bridge, _load_error
    _bridge = bridge
    _install_finders()
    _patch_threads()
    _patch_desktop()
    _patch_platform()
    for d in (PLUGIN_DIR, CONFIG_DIR, PROJECT_DIR, UPLOAD_DIR, CONFIG_DIR + "/scripting", CONFIG_DIR + "/colors"):
        os.makedirs(d, exist_ok=True)
    # KiCad's own settings files, for plugins that read them (language, theme, the 3D model path).
    for name, body in (("kicad_common.json", {"appearance": {"icon_theme": "auto", "toolbar_icon_size": 24}, "system": {"language": "Default", "editor_name": "", "working_dir": PROJECT_DIR},
                                              "environment": {"vars": {}}, "input": {}, "meta": {"version": 3}}),
                       ("pcbnew.json", {"meta": {"version": 5}, "system": {"units": 1}, "window": {"grid": {"last_size": 12, "sizes": []}}}),
                       ("kicad.json", {"meta": {"version": 2}, "system": {"open_projects": []}})):
        if not os.path.exists(f"{CONFIG_DIR}/{name}"):
            _write(f"{CONFIG_DIR}/{name}", json.dumps(body, indent=2).encode("utf-8"))
    os.environ.setdefault("KICAD_WEB_OUTPUT", PROJECT_DIR)
    os.environ.setdefault("KICAD_WEB_CONFIG", CONFIG_DIR)
    os.environ.setdefault("HOME", ROOT + "/home")
    os.environ.setdefault("KICAD_CONFIG_HOME", CONFIG_DIR)
    os.makedirs(os.environ["HOME"], exist_ok=True)
    # where a desktop KiCad keeps its settings, for plugins that look there themselves
    try:
        home_cfg = os.path.join(os.environ["HOME"], ".config", "kicad")
        os.makedirs(home_cfg, exist_ok=True)
        ver = ".".join(str(pcbnew._Host.version).split(".")[:2])
        if not os.path.exists(os.path.join(home_cfg, ver)):
            os.symlink(CONFIG_DIR, os.path.join(home_cfg, ver))
    except OSError:
        pass
    pcbnew._Host.plugin_dir = PLUGIN_DIR
    pcbnew._Host.config_dir = CONFIG_DIR
    pcbnew._Host.on_register = _on_register
    pcbnew._Host.on_register_wizard = _on_register_wizard
    pcbnew._Host.refresh = flush
    # where a desktop installation keeps KiCad's libraries: plugins build library paths from these
    for v in ("", "6", "7", "8", "9", "10"):
        os.environ.setdefault("KICAD%s_FOOTPRINT_DIR" % v, pcbnew.FOOTPRINT_DIR)
        os.environ.setdefault("KICAD%s_SYMBOL_DIR" % v, "/usr/share/kicad/symbols")
        os.environ.setdefault("KICAD%s_3DMODEL_DIR" % v, MODEL_DIR)
    os.environ.setdefault("KISYS3DMOD", MODEL_DIR)
    os.environ.setdefault("KIPRJMOD", PROJECT_DIR)
    if bridge is not None:
        pcbnew._Host.library = _library
        _install_library_files()
        _install_model_files()
        _install_fabrication()
    import kicad_net
    kicad_net.install((lambda request: _call("net.fetch", request)) if bridge is not None else None)
    pcbnew._Host.focus = _focus
    pcbnew._Host.highlight = _highlight
    wx._bridge = _WxBridge() if bridge is not None else None
    # wx.Clipboard is the editors' own copy buffer: Copy in the schematic or board editor fills it, Paste there reads it
    wx._Clipboard._wx_read = (lambda: str((_call("design.copied") or {}).get("text") or "")) if bridge is not None else None
    wx._Clipboard._wx_write = (lambda text: _call("design.copy", {"text": text})) if bridge is not None else None
    wx._after_event = _after_event
    wx._before_event = _before_event
    wx._editor.update(actions=lambda: [(str(getattr(p, "name", "") or type(p).__name__), p) for p in _actions], run=_editor_run,
                      panels=_appearance.refresh, undo=lambda: _editor_history("design.undo"), redo=lambda: _editor_history("design.redo"), key=_editor_key,
                      title=lambda: os.path.splitext(os.path.basename(pcbnew._Host.board.GetFileName()))[0] if pcbnew._Host.board is not None else "")
    pkg = install_files(identifier, files)
    _plugin.update(identifier=identifier, package=pkg, name=name or identifier)
    _restore_state()
    if PLUGIN_DIR not in sys.path:
        sys.path.insert(0, PLUGIN_DIR)
    os.chdir(PROJECT_DIR)
    _load_error = None
    import logging
    logging.basicConfig(level=logging.DEBUG if os.environ.get("KICAD_WEB_DEBUG") else logging.WARNING, format="%(levelname)s %(name)s: %(message)s", force=True)
    base = f"{PLUGIN_DIR}/{pkg}"
    ipc = _ipc_manifest(base)
    _prefer_runtime_binaries(base)
    try:
        import importlib.util
        if importlib.util.find_spec("numpy") is not None:        # loaded for this plugin: it imports numpy
            import kicad_compat
            kicad_compat.numpy_wide_counts()
    except Exception as e:
        log.warning("numpy could not be prepared: %s", e)
    try:
        if os.path.exists(f"{base}/__init__.py"):
            pcbnew.LoadPluginModule(PLUGIN_DIR, pkg, pkg)
        elif ipc is not None:
            pass        # a program of its own (KiCad's IPC kind): KiCad starts its entry point per action and imports nothing
        else:
            # not a package itself: loose .py files, or packages one folder down
            sys.path.insert(0, base)
            for fn in sorted(os.listdir(base)):
                if fn.endswith(".py") and not fn.startswith("_"):
                    pcbnew.LoadPluginModule(base, fn[:-3], fn)
                elif os.path.exists(f"{base}/{fn}/__init__.py") and fn.isidentifier():
                    pcbnew.LoadPluginModule(base, fn, fn)
    except BaseException as e:           # a plugin may call sys.exit() or raise anything at import
        _load_error = _describe(e)
        traceback.print_exc()
    if ipc is not None and not _actions:
        folder, manifest = ipc
        for a in manifest.get("actions") or []:
            if isinstance(a, dict) and a.get("entrypoint") and "pcb" in (a.get("scopes") or ["pcb"]):
                _actions.append(_IpcAction(folder, manifest, a))
        if _actions:
            _load_error = None
    return json.dumps(describe())


def _ipc_manifest(base):
    """The plugin.json of a plugin for KiCad's IPC interface: beside the plugin's files, or one folder down."""
    spots = [base] + sorted(f"{base}/{d}" for d in (os.listdir(base) if os.path.isdir(base) else []) if os.path.isdir(f"{base}/{d}"))
    for folder in spots:
        path = f"{folder}/plugin.json"
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    manifest = json.load(fh)
            except (OSError, ValueError):
                continue
            if isinstance(manifest, dict) and isinstance(manifest.get("actions"), list) and (manifest.get("runtime") or {}).get("type", "python") == "python":
                return folder, manifest
    return None


class _IpcAction:
    """One action of a plugin.json: KiCad runs its entry point as a program; so does Run()."""

    def __init__(self, folder, manifest, action):
        self.name = str(action.get("name") or manifest.get("name") or "Action")
        self.description = str(action.get("description") or manifest.get("description") or "")
        self.category = "IPC"
        self.show_toolbar_button = bool(action.get("show-button"))
        self.icon_file_name = ""
        for key in ("icons-light", "icons-dark"):
            for icon in action.get(key) or []:
                path = os.path.normpath(f"{folder}/{icon}")
                if path.startswith(folder + "/") and os.path.isfile(path) and path.lower().endswith(".png") and not self.icon_file_name:
                    self.icon_file_name = path
        self._folder = folder
        self._entry = os.path.normpath(f"{folder}/{action['entrypoint']}")
        self._args = [str(x) for x in (action.get("args") or [])]

    def Run(self):
        import runpy
        import kicad_ipc
        if not self._entry.startswith(self._folder + "/") or not os.path.isfile(self._entry):
            raise pcbnew.WebUnsupported("This action's entry point is not in the plugin")
        kicad_ipc.reset()
        os.environ["KICAD_API_SOCKET"] = "ipc:///tmp/kicad/api.sock"
        os.environ["KICAD_API_TOKEN"] = kicad_ipc._state["token"]
        # Every run is a new process on the desktop: the plugin's own modules start fresh.
        for name, mod in list(sys.modules.items()):
            f = getattr(mod, "__file__", None) or ""
            if f.startswith(self._folder + "/"):
                del sys.modules[name]
        argv, path, cwd = sys.argv, list(sys.path), os.getcwd()
        sys.argv = [self._entry] + self._args
        sys.path.insert(0, os.path.dirname(self._entry))
        wx._process_mode = True
        try:
            runpy.run_path(self._entry, run_name="__main__")
        finally:
            wx._process_mode = False
            sys.argv, sys.path[:] = argv, path
            try:
                os.chdir(cwd)
            except OSError:
                pass
            if kicad_ipc._state["commit"] is not None:      # left open: KiCad closes it with the connection
                kicad_ipc._state["commit"] = None


def _describe(e):
    if isinstance(e, ModuleNotFoundError):
        return f"it needs the Python module “{e.name}”, which the web editor does not have"
    if isinstance(e, pcbnew.WebUnsupported):
        return str(e)
    text = f"{type(e).__name__}: {e}".strip().rstrip(":")
    return text[:400]


def _icon(plugin):
    path = getattr(plugin, "icon_file_name", "") or ""
    if path and os.path.isfile(path) and os.path.getsize(path) < 60000:
        return wx._data_url(path)
    return ""


def describe():
    out = []
    for i, p in enumerate(_actions):
        out.append({"index": i, "name": str(getattr(p, "name", "") or f"Action {i + 1}")[:120], "description": str(getattr(p, "description", "") or "")[:400],
                    "category": str(getattr(p, "category", "") or "")[:80], "button": bool(getattr(p, "show_toolbar_button", False)), "icon": _icon(p),
                    "wizard": hasattr(p, "wizard")})
    return {"actions": out, "error": _load_error, "missing": {"pcbnew": sorted(pcbnew._missing), "wx": sorted(wx._missing)}}


# ----------------------------------------------------------------------------- talking to the editor

def _call(method, args=None):
    """One request to the editor; blocks until it answers.  Returns the decoded result."""
    if _bridge is None:
        return None
    out = _bridge(method, json.dumps(args or {}))
    return json.loads(out) if isinstance(out, str) and out else out


def _install_library_files():
    """KiCad's footprint libraries as the files a desktop installation has under its footprints folder.  A plugin
    that looks for <library>.pretty or for a .kicad_mod file in it there finds it: the folder, or the file with
    the footprint's own text, is fetched from the editor's libraries the first time it is asked about."""
    root = pcbnew.FOOTPRINT_DIR
    try:
        os.makedirs(root, exist_ok=True)
    except OSError:
        return
    real = {name: getattr(os.path, name) for name in ("isdir", "isfile", "exists")}
    libraries, missing = {}, set()

    def fetch(path):
        try:
            p = os.fspath(path)
        except TypeError:
            return
        if not isinstance(p, str) or not p.startswith(root + "/") or p in missing or real["exists"](p):
            return
        parts = p[len(root) + 1:].rstrip("/").split("/")
        if not parts[0].endswith(".pretty") or len(parts) > 2:
            return
        nick = parts[0][:-len(".pretty")]
        try:
            if nick not in libraries:
                libraries[nick] = bool(_library("footprints", {"lib": nick}).get("footprints"))
                if libraries[nick]:
                    os.makedirs(os.path.join(root, parts[0]), exist_ok=True)
            if libraries[nick] and len(parts) == 2 and parts[1].endswith(".kicad_mod"):
                text = _library("footprint", {"lib": nick, "name": parts[1][:-len(".kicad_mod")]}).get("footprint")
                if text:
                    with open(p, "w", encoding="utf-8") as f:
                        f.write(text)
                    return
            elif libraries[nick] and len(parts) == 1:
                return
        except Exception as e:                       # the libraries cannot be reached: the file is not there
            log.warning("footprint library files: %s", e)
        missing.add(p)

    def looking(name):
        def check(path):
            fetch(path)
            return real[name](path)
        check.__name__ = name
        return check
    for name in real:
        setattr(os.path, name, looking(name))


MODEL_DIR = "/usr/share/kicad/3dmodels"


def _read_back(path, mode, real_open):
    """A plugin that reads again a file it handed over earlier (an export the person was to change in another program,
    like a drawing of the board) is after the person's changed copy, which is on their computer: they are asked for
    it, once a run.  Cancel leaves the copy from the last run, if this session still has it."""
    if not mode.startswith("r") or "+" in mode:
        return
    try:
        p = os.path.abspath(os.fspath(path))
    except (TypeError, OSError):
        return
    if not p.startswith(PROJECT_DIR + "/"):
        return
    rel = os.path.relpath(p, PROJECT_DIR).replace(os.sep, "/")
    if rel not in _state["handed"] or rel in _state["asked_back"]:
        return
    _state["asked_back"].add(rel)
    name, ext = os.path.basename(rel), os.path.splitext(rel)[1].lower()
    try:
        out = _call("files.pick", {"title": "%s reads %s. Choose the file to use, or cancel to use the one from its last run." % (_label[0], name),
                                   "accept": [ext] if ext else [], "as": "base64"})
    except Exception as e:
        log.warning("%s could not be asked for: %s", name, e)
        return
    if out and "name" in out:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with real_open(p, "wb") as fh:
            fh.write(base64.b64decode(out.get("base64", "")) if "base64" in out else str(out.get("text", "")).encode("utf-8"))


# Drawings are what a person takes to another program and brings back; a plugin's notes and settings beside the board
# are read back all the time and are kept here anyway, so they are never asked for.
_ROUND_TRIP = (".svg", ".dxf")


def _handed_key():
    return (_state["project"] or "py.project") + ".handed"


def _note_handed(paths):
    """Remember, per project, which files this plugin handed over as downloads (see _read_back)."""
    rels = {os.path.relpath(p, PROJECT_DIR).replace(os.sep, "/") for p in paths}
    rels = {r for r in rels if r.lower().endswith(_ROUND_TRIP)}
    if not rels - _state["handed"]:
        return
    _state["handed"] |= rels
    try:
        _call("storage.set", {"key": _handed_key(), "value": sorted(_state["handed"])[-200:]})
    except Exception as e:
        log.warning("could not note the files handed over: %s", e)


_fp_table_done = [False]


def _global_fp_table(path):
    """A desktop KiCad has a global footprint library table in its settings folder that names every library it came
    with.  Plugins that resolve a library nickname read it; it is written here the first time one looks for it."""
    if _fp_table_done[0] or not isinstance(path, str) or not path.endswith("fp-lib-table"):
        return
    try:
        if os.path.realpath(os.path.dirname(os.path.abspath(path))) != os.path.realpath(CONFIG_DIR):
            return
        _fp_table_done[0] = True
        target = os.path.join(CONFIG_DIR, "fp-lib-table")
        if os.path.lexists(target):
            return
        names = pcbnew.GetFootprintLibraries() if hasattr(pcbnew, "GetFootprintLibraries") else []
        rows = "".join('\t(lib (name "%s")(type "KiCad")(uri "${KICAD%s_FOOTPRINT_DIR}/%s.pretty")(options "")(descr ""))\n'
                       % (n, str(pcbnew._Host.version).split(".")[0], n) for n in sorted(names))
        if rows:
            _write(target, ("(fp_lib_table\n\t(version 7)\n" + rows + ")\n").encode("utf-8"))
    except Exception as e:                           # the libraries cannot be reached: no table, as on a bare installation
        log.warning("global footprint library table: %s", e)


def _install_model_files():
    """KiCad's 3D model library as the files a desktop installation has under its 3dmodels folder: a plugin that
    opens, copies or looks for <library>.3dshapes/<name>.step there gets the model, fetched through the editor the
    first time.  The library publishes STEP files only, so the .wrl of the same name is not there."""
    import builtins
    root = MODEL_DIR
    try:
        os.makedirs(root, exist_ok=True)
    except OSError:
        return
    real_exists = os.path.exists          # (already looks up footprint library files)
    missing = set()

    def fetch(path):
        try:
            p = os.fspath(path)
        except TypeError:
            return
        _global_fp_table(p)
        if not isinstance(p, str) or not p.startswith(root + "/") or p in missing:
            return
        parts = p[len(root) + 1:].split("/")
        if len(parts) != 2 or not parts[0].endswith(".3dshapes") or not parts[1].endswith(".step") or real_exists(p):
            return
        lib, name = parts[0][:-len(".3dshapes")], parts[1][:-len(".step")]
        try:
            text = (_library("model", {"lib": lib, "name": name}) or {}).get("step")
            if text:
                os.makedirs(os.path.join(root, parts[0]), exist_ok=True)
                with real_open(p, "w", encoding="utf-8", newline="") as f:
                    f.write(text)
                return
        except Exception as e:                       # the library cannot be reached: the file is not there
            log.warning("3D model library files: %s", e)
        missing.add(p)

    real_open = builtins.open

    def open_(file, *a, **k):
        if isinstance(file, (str, os.PathLike)):
            fetch(file)
            if _state["handed"] and _running[0] > 0:
                _read_back(file, str(a[0] if a else k.get("mode", "r")), real_open)
        return real_open(file, *a, **k)
    open_.__name__ = "open"
    open_.__doc__ = real_open.__doc__
    builtins.open = open_

    def looking(name, real):
        def check(path):
            fetch(path)
            return real(path)
        check.__name__ = name
        return check
    for name in ("isfile", "exists"):
        setattr(os.path, name, looking(name, getattr(os.path, name)))


def _library(what, args):
    """KiCad's footprint libraries, through the editor.  An unknown library or footprint is an empty answer."""
    r = _call("libs." + what, args)
    if isinstance(r, dict) and r.get("error"):
        log.warning("footprint library: %s", r["error"])
        return {}
    return r or {}


class _WxBridge:
    """The stock dialogs wx asks the editor to draw."""

    def confirm(self, title, message, ok="OK", cancel="Cancel"):
        return bool(_call("ui.confirm", {"title": title, "message": message, "okLabel": ok if isinstance(ok, str) else "OK", "plain": cancel is None}))

    def prompt(self, title, message, value=""):
        out = _call("ui.prompt", {"title": title, "message": message if "\n" in str(message) else "", "fields": [
            {"name": "value", "label": (str(message) if "\n" not in str(message) else "Value")[:120] or "Value", "default": value}]})
        return None if not out else out.get("value", "")

    def choose(self, title, message, choices, selected=0):
        out = _call("ui.prompt", {"title": title, "message": message, "fields": [
            {"name": "value", "label": "Choice", "type": "select", "options": choices, "default": choices[selected] if choices else ""}]})
        return None if not out else out.get("value")

    def pick(self, title, extensions):
        out = _call("files.pick", {"title": title, "accept": extensions, "as": "base64"})
        if not out or "name" not in out:
            return None
        path = f"{UPLOAD_DIR}/{os.path.basename(out['name'])}"
        _write(path, base64.b64decode(out.get("base64", "")) if "base64" in out else str(out.get("text", "")).encode("utf-8"))
        return path

    def status(self, text):
        try:
            _call("ui.status", {"text": text, "nowait": True})
        except Exception:
            pass


def _focus(item):
    try:
        _call("view.focus", {"ids": [item.m_Uuid.AsString()]})
    except Exception:
        pass


def _board_path(info):
    name = os.path.basename(str((info or {}).get("path") or "board.kicad_pcb")) or "board.kicad_pcb"
    if not name.endswith(".kicad_pcb"):
        name += ".kicad_pcb"
    return f"{PROJECT_DIR}/{name}"


def load_board():
    """Fetch the open board from the editor and make it the board GetBoard() returns."""
    info = _call("design.board") or {}
    text = info.get("text") or ""
    path = _board_path(info)
    if not text:
        raise pcbnew.WebUnsupported("Running this plugin without a board open")
    _write(path, text.encode("utf-8"))
    _state["given"].add(os.path.relpath(path, PROJECT_DIR).replace(os.sep, "/"))
    _state["board_file"] = (path, text)
    project = {}
    for f in info.get("files") or []:
        rel = os.path.normpath(str(f.get("path") or "")).replace("\\", "/")
        if not rel or rel.startswith("..") or rel.startswith("/"):
            continue
        _write(f"{PROJECT_DIR}/{rel}", str(f.get("text") or "").encode("utf-8"))
        _state["given"].add(rel)
        if rel.endswith((".kicad_sch", ".kicad_pcb")) or rel in ("fp-lib-table", "sym-lib-table"):
            _state["given_text"][rel] = str(f.get("text") or "")
        if rel.endswith(".kicad_pro") and (not project or os.path.splitext(rel)[0] == os.path.splitext(os.path.basename(path))[0]):
            try:
                project = json.loads(f.get("text") or "{}")
            except ValueError:
                pass
    pcbnew._Host.project = project if isinstance(project, dict) else {}
    if _state["project"] is None:
        _restore_project_state(info.get("projectId") or info.get("project") or os.path.basename(path))
    board = pcbnew.BOARD(text, path)
    for uid in info.get("selection") or []:
        it = board.GetItem(uid)
        if it is not None:
            it._selected = True
    board._selection_changed = False
    pcbnew._Host.board = board
    if isinstance(info.get("grid"), (int, float)) and info["grid"] > 0:
        pcbnew._Host.grid_mm = float(info["grid"])
    if info.get("version"):
        pcbnew._Host.version = str(info["version"])
    return board


def flush():
    """Send what the plugin changed so far to the editor (one undo step) and start counting again."""
    board = pcbnew._Host.board
    if board is None or _bridge is None:
        return None
    if getattr(board, "_saved_as_from", None):
        # the plugin renamed the open board (a "save as"): its changes belong to the new file, not to the live board
        _saved_as[0] = board.GetFileName()
        return None
    ch = board._changes()
    select = ch.pop("select")
    refill = ch.pop("refill")
    out = None
    if ch["create"] or ch["update"] or ch["transform"] or ch["remove"]:
        ch["label"] = _label[0]
        out = _call("design.commit", ch)
        board._committed()
        for it in board._items:
            if getattr(it, "_pending", None):
                it._write_placement(it._pending)       # the editor moved it; our copy now says the same
                it._pending = None
                it._content = it._dirty = False
    else:
        board._selection_changed = False
        board._wants_refill = False
    if select is not None:
        try:
            _call("view.select", {"ids": select})
        except Exception:
            pass
    if refill:
        _refill_note[0] = "filled" if refill == "filled" and _refill_note[0] in (False, "filled") else True
    return out


_label = ["edit"]
_refill_note = [False]
_saved_as = [None]          # the file name a plugin gave the open board in this run ("save as"), if it did
_event_depth = [0]


def _after_event():
    """A handler of a window the plugin left open has run: what it changed goes to the editor now."""
    if (_running[0] and not wx._in_mainloop[0]) or _event_depth[0]:
        return
    _event_depth[0] += 1
    try:
        b = pcbnew._Host.board
        if b is not None and b._modified:
            flush()
        _export_outputs()          # a handler may only write files (an image, a report): they are handed over as well
    except Exception:
        traceback.print_exc()
    finally:
        _event_depth[0] -= 1


# ----------------------------------------------------------------------------- the board editor, as plugins work it

_stale = [False]          # the editor's board changed since this interpreter read it


def _highlight(nets):
    if _bridge is None:
        return
    try:
        _call("view.highlight", {"nets": list(nets or [])})
    except Exception:
        pass


def _before_event():
    """A handler of a window the plugin left open is about to run.  KiCad's plugins read the live board; here the board
    is a copy, so when the editor's board changed since it was read (the person edited, someone else did, an undo), it is
    read again first.  Not while the plugin's own unsent changes are in it."""
    if not _stale[0] or _running[0] or _event_depth[0] or _bridge is None:
        return
    b = pcbnew._Host.board
    if b is None or b._modified:
        return
    _stale[0] = False
    _event_depth[0] += 1
    try:
        load_board()
    except Exception:
        traceback.print_exc()
    finally:
        _event_depth[0] -= 1


def editor_event(name, payload="{}"):
    """The editor says something happened in it: the selection changed (the person clicked), or the board did."""
    try:
        data = json.loads(payload) if isinstance(payload, str) else (payload or {})
    except ValueError:
        data = {}
    if name == "change":
        _stale[0] = True
        return
    if name != "selection":
        return
    b = pcbnew._Host.board
    if b is None:
        return
    ids = set(str(i) for i in (data.get("ids") or []))
    was = {it.m_Uuid.AsString() for it in b.GetCurrentSelection()}
    if ids == was:
        return
    changed = b._selection_changed
    for it in list(b.GetCurrentSelection()):
        it._selected = False
    for uid in ids:
        it = b.GetItem(uid)
        if it is not None:
            it._selected = True
    b._selection_changed = changed          # this is the editor's selection arriving, not one to send back
    wx._editor_canvas_event("click")


def _editor_run(plugin):
    """An action plugin chosen from the editor's Tools → External Plugins menu: KiCad runs it inside one board commit."""
    label = _label[0]
    _label[0] = str(getattr(plugin, "name", "") or "edit")[:80]
    try:
        plugin.Run()
    finally:
        try:
            b = pcbnew._Host.board
            if b is not None and (b._modified or b._selection_changed):
                flush()
        finally:
            _label[0] = label
    return True


def _editor_history(method):
    """Edit → Undo / Redo of the board editor."""
    if _bridge is None:
        return False
    out = _call(method, {}) or {}
    if out.get("done"):
        _stale[0] = True
        try:
            _event_depth[0] += 1
            load_board()
            _stale[0] = False
        finally:
            _event_depth[0] -= 1
    return bool(out.get("done"))


class _Appearance:
    """The Nets part of KiCad's Appearance panel, as windows of the board editor's frame: a grid with one row per net
    (colour, ratsnest shown, name) and the two choices under it (net colours: All / Ratsnest / None; ratsnest display:
    All / Visible layers / None).  A plugin that works these on the desktop works the web editor's Appearance panel."""

    COLOR_MODES = (("All", "all"), ("Ratsnest", "ratsnest"), ("None", "off"))
    RATSNEST_MODES = (("All", "all"), ("Visible layers", "visible"), ("None", "none"))

    def __init__(self):
        self.panel = None
        self.batch = 0
        self.queue = []
        self.filling = False

    def state(self, actions=None):
        if _bridge is not None:
            try:
                out = _call("view.appearance", {"actions": actions or []})
                if isinstance(out, dict) and isinstance(out.get("nets"), list):
                    return out
            except Exception:
                traceback.print_exc()
        b = pcbnew._Host.board
        names = [n.GetNetname() for n in b.GetNetsByNetcode().values() if n.GetNetname()] if b is not None else []
        return {"nets": [{"name": n, "color": None, "visible": True} for n in names], "netColorMode": "ratsnest", "ratsnestMode": "all"}

    def send(self, action):
        if self.filling:
            return
        if self.batch:
            self.queue.append(action)
        else:
            self.state([action])

    def build(self, frame):
        import wx.grid as wxgrid
        me = self

        class NetsGrid(wxgrid.Grid):
            def SetCellValue(self, row, col, value=None):
                wxgrid.Grid.SetCellValue(self, row, col, value)
                if isinstance(row, int) and isinstance(col, int) and 0 <= row < self.GetNumberRows():
                    name, text = wxgrid.Grid.GetCellValue(self, row, 2), str(value)
                    if col == 0:
                        ok = len(text) == 7 and text[0] == "#" and all(ch in "0123456789abcdefABCDEF" for ch in text[1:])
                        me.send({"t": "netColor", "name": name, "color": text if ok else None})
                    elif col == 1:
                        me.send({"t": "netVisible", "name": name, "on": text != "0"})

            def BeginBatch(self):
                me.batch += 1

            def EndBatch(self):
                me.batch = max(0, me.batch - 1)
                if not me.batch and me.queue:
                    queued, me.queue = me.queue, []
                    me.state(queued)

        self.panel = wx.Panel(frame)
        self.panel.SetName("Appearance")
        self.grid = NetsGrid(self.panel)
        self.grid.CreateGrid(0, 3)
        self.radios = {}
        for key, modes in (("netColorMode", self.COLOR_MODES), ("ratsnestMode", self.RATSNEST_MODES)):
            box = wx.Panel(self.panel)
            for label, mode in modes:
                radio = wx.RadioButton(box, label=label)
                radio.Bind(wx.EVT_RADIOBUTTON, lambda e, k=key, m=mode: self.choose(k, m))
                self.radios[key, mode] = radio

    def choose(self, key, mode):
        for (k, m), radio in self.radios.items():
            if k == key:
                radio.SetValue(m == mode)
        self.send({"t": key, "mode": mode})

    def refresh(self, frame):
        if pcbnew._Host.board is None:
            return
        if self.panel is None:
            self.build(frame)
        import wx.grid as wxgrid
        st = self.state()
        self.filling = True
        try:
            g, rows = self.grid, st["nets"]
            have = g.GetNumberRows()
            if have < len(rows):
                g.AppendRows(len(rows) - have)
            elif have > len(rows):
                g.DeleteRows(len(rows), have - len(rows))
            for i, n in enumerate(rows):
                for col, text in ((0, n.get("color") or "rgba(0,0,0,0)"), (1, "1" if n.get("visible", True) else "0"), (2, n.get("name") or "")):
                    if wxgrid.Grid.GetCellValue(g, i, col) != text:
                        wxgrid.Grid.SetCellValue(g, i, col, text)
            for (key, mode), radio in self.radios.items():
                radio.SetValue(st.get(key) == mode)
        finally:
            self.filling = False


_appearance = _Appearance()


_HOTKEY_DEFAULTS = {"pcbnew.EditorControl.highlightNet": "`", "pcbnew.EditorControl.clearHighlight": "~"}


def _hotkey_actions():
    """KiCad's hotkeys as the plugin sees them: the defaults, then the person's user.hotkeys file (action, key, …)."""
    keys = dict(_HOTKEY_DEFAULTS)
    try:
        with open(os.path.join(CONFIG_DIR, "user.hotkeys"), encoding="utf-8-sig") as fh:
            for line in fh:
                fields = line.rstrip("\n").split("\t")
                if len(fields) > 1 and fields[0] and not fields[0].startswith("#"):
                    keys[fields[0]] = fields[1]
    except OSError:
        pass
    return keys


def _key_name(event):
    code = event.GetKeyCode()
    names = {27: "Esc", 13: "Enter", 9: "Tab", 32: "Space", 8: "Back", 127: "Del"}
    if wx.WXK_F1 <= code <= wx.WXK_F1 + 23:
        name = "F%d" % (code - wx.WXK_F1 + 1)
    elif code in names:
        name = names[code]
    elif 32 < code < 127:
        name = chr(code).upper()
    else:
        return None
    mods = [m for m, on in (("Ctrl", event.ControlDown()), ("Alt", event.AltDown()), ("Shift", event.ShiftDown())) if on]
    return frozenset(mods), name


def _editor_paste():
    """Ctrl+V in the board editor, as a plugin presses it after putting a footprint on the clipboard (KiCad pastes the
    clipboard's text when it is board items).  The footprints in that text are added to the board as one change, at
    the place they name; one that names none goes to the middle of what is on the board.  True when something was pasted."""
    text = (wx.TheClipboard._wx_last or "").strip()
    if not text.startswith("("):
        return False
    b = pcbnew.GetBoard()
    try:
        root = pcbnew._parse(text)[0]
    except Exception:
        return False
    kind = str(root[0]) if root else ""
    texts = [text] if kind in ("footprint", "module") else []
    if kind == "kicad_pcb":
        texts = [pcbnew._dump(k) for k in root if isinstance(k, list) and k and str(k[0]) in ("footprint", "module")] if hasattr(pcbnew, "_dump") else []
    if not texts:
        log.warning("paste: the clipboard holds no footprint (it starts with (%s …)", kind)
        return False
    box = b.GetBoardEdgesBoundingBox() if b.GetBoardEdgesBoundingBox().GetWidth() > 0 else b.ComputeBoundingBox(False)
    middle = box.GetCenter() if box.GetWidth() > 0 else pcbnew.VECTOR2I(pcbnew.FromMM(100), pcbnew.FromMM(100))
    for item in list(b.GetCurrentSelection()):
        item.ClearSelected()
    added = 0
    for t in texts:
        fp = pcbnew._footprint_from_text(t)
        at = fp.GetPosition()
        if at.x == 0 and at.y == 0:
            fp.SetPosition(middle)
        b.Add(fp)
        fp.SetSelected()
        added += 1
    flush()
    return added > 0


def _editor_key(event):
    """A key sent to the board editor's canvas: the editor action that key stands for is done.  The actions a plugin
    can work this way are the ones about highlighting nets; True when the key was one of them."""
    pressed = _key_name(event)
    b = pcbnew._Host.board
    if pressed is None or b is None:
        return False
    if pressed == (frozenset(("Ctrl",)), "V"):
        return _editor_paste()
    if pressed[1] == "Esc":                 # "leave the tool I am in": there is none to leave
        return True
    for action, text in _hotkey_actions().items():
        parts = [p for p in str(text).split("+") if p]
        if not parts or (frozenset(parts[:-1]), parts[-1].upper()) != (pressed[0], pressed[1].upper()):
            continue
        if action == "pcbnew.EditorControl.highlightNetSelection":
            nets = sorted({it.GetNetCode() for it in b.GetCurrentSelection() if hasattr(it, "GetNetCode") and it.GetNetCode() > 0})
            if not nets:
                return False
            b.ResetNetHighLight()
            for i, code in enumerate(nets):
                b.SetHighLightNet(code, i > 0)
            b.HighLightON()
            return True
        if action == "pcbnew.EditorControl.clearHighlight":
            b.ResetNetHighLight()
            return True
        return False
    return False


# ----------------------------------------------------------------------------- files a plugin writes

def _tree(root):
    out = {}
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]      # a plugin's hidden housekeeping folders are never handed over
        for n in names:
            p = os.path.join(base, n)
            try:
                st = os.stat(p)
                out[p] = (st.st_mtime_ns, st.st_size)
            except OSError:
                pass
    return out


_seen_files = {}


def _export_outputs():
    """Whatever the plugin wrote into the project folder is offered to the person as a download; its settings are kept."""
    _save_state()
    return _hand_over_outputs()


_LIBRARY_FILE = re.compile(r"^(?:[^/]+/)*(?:[^/]+\.kicad_sym|[^/]+\.pretty/[^/]+\.kicad_mod|[^/]+\.3dshapes/[^/]+\.(?:step|stp|wrl))$", re.I)


def _models_named():
    """The model files in the project folder that the board's footprints name (${KIPRJMOD}/packages3D/R_0603.step), as
    paths from the project folder without the extension (a footprint may name the .wrl where the file is the .step).  A plugin that copies the models into the project and points the footprints at
    the copies has made them part of the project."""
    out = set()
    board = pcbnew._Host.board
    if board is None:
        return out
    try:
        for fp in board.GetFootprints():
            for m in fp._kids()["models"]:
                hit = re.match(r"^\$[{(]KIPRJMOD[})][/\\](.+\.(?:step|stp|wrl))$", m.m_Filename, re.I)
                if hit and ".." not in hit.group(1):
                    out.add(os.path.splitext(hit.group(1).replace("\\", "/"))[0])
    except Exception as e:
        log.warning("3D models named by the board: %s", e)
    return out


def _offer_libraries(fresh):
    """Symbol libraries, footprints and 3D models a plugin wrote into the project folder (a part import) are offered to
    the project's own libraries, as they would simply be part of the project on the desktop.  Returns the files that
    were not taken (the person said no, a viewer, a file that is not text), which are handed over as a download."""
    offer = []
    named, wanted = _models_named(), False
    for p in fresh:
        rel = os.path.relpath(p, PROJECT_DIR).replace(os.sep, "/")
        is_model = rel.lower().endswith((".step", ".stp", ".wrl")) and os.path.splitext(rel)[0] in named
        if not _LIBRARY_FILE.match(rel) and not is_model:
            continue
        wanted = wanted or is_model
        try:
            with open(p, "rb") as fh:
                data = fh.read(8_000_001)
            if len(data) <= 8_000_000:
                offer.append((p, {"path": rel, "text": data.decode("utf-8")}))
        except (OSError, UnicodeDecodeError):
            pass
    if not any(f["path"].lower().endswith((".kicad_sym", ".kicad_mod")) for _p, f in offer) and not wanted:
        return fresh                              # models alone, that no footprint of the board names, are an output
    try:
        out = _call("project.addLibraryFiles", {"files": [f for _p, f in offer]}) or {}
    except Exception as e:
        log.warning("The libraries could not be added to the project: %s", e)
        return fresh
    taken = set(out.get("added") or []) | set(out.get("updated") or [])
    if taken:
        log.info("Added to the project's libraries: %s", ", ".join(sorted(taken)))
    return [p for p in fresh if os.path.relpath(p, PROJECT_DIR).replace(os.sep, "/") not in taken and not _table_covered(p, taken)]


_TABLE_ROW = re.compile(r'\(lib\s*\(name\s*"((?:[^"\\]|\\.)*)"\)\s*\(type\s*"?([^")\s]*)"?\)\s*\(uri\s*"((?:[^"\\]|\\.)*)"\)')


def _table_covered(path, taken):
    """The project's library table (fp-lib-table, sym-lib-table) as a plugin wrote it.  The editor keeps the project's
    tables itself and has just added a row for every library it took, so a table that only gained rows for those
    libraries says nothing new and is not handed over as a download.  Any other change to it is."""
    rel = os.path.relpath(path, PROJECT_DIR).replace(os.sep, "/")
    if rel not in ("fp-lib-table", "sym-lib-table"):
        return False
    try:
        with open(path, encoding="utf-8") as fh:
            now = {m.group(1): m.group(3) for m in _TABLE_ROW.finditer(fh.read())}
    except (OSError, UnicodeDecodeError):
        return False
    before = {m.group(1): m.group(3) for m in _TABLE_ROW.finditer(_state["given_text"].get(rel) or "")}
    if any(now.get(name) != uri for name, uri in before.items()):
        return False                                 # a row was taken out or pointed elsewhere
    for name, uri in now.items():
        if name in before:
            continue
        hit = re.match(r"^\$[{(]KIPRJMOD[})][/\\](.+)$", uri)
        where = hit.group(1).replace("\\", "/").rstrip("/") if hit else None
        if not where or not any(t == where or t.startswith(where + "/") for t in taken):
            return False
    return True


def _carry_board_file():
    """A desktop plugin that edits the board outside KiCad (export, change the export elsewhere, import) ends by writing
    the board's own file again, and the person reopens it.  Here the board is the editor's, so what the file says is
    carried into it as ordinary edits, one undo step: footprints are moved, turned and flipped, and take the library name and 3D model files the file gives them; tracks, vias and
    lines drawn on the board are moved, added and removed; zone outlines are redrawn.  Only where things are is taken
    from the file: such plugins write a bare board (no ids, few settings), so every item keeps its own properties and
    new copper is a copy of copper of the same net and layer.  Other drawings (text, arcs, circles, filled shapes) and
    anything the file leaves out of a footprint stay as they are."""
    board = pcbnew._Host.board
    path, given = _state.get("board_file") or (None, None)
    if board is None or not path or board.GetFileName() != path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError):
        return None
    if text == given or text == board._text():
        return None
    _state["board_file"] = (path, text)
    try:
        root = pcbnew._parse(text)[0]
    except Exception as e:
        log.warning("The board file the plugin wrote could not be read: %s", e)
        return None
    if not isinstance(root, list) or not root or str(root[0]) != "kicad_pcb":
        return None
    kid, num = pcbnew._kid, pcbnew._f
    TOL = 2000                                    # nm: what a round trip through another program's units loses
    nm = lambda v: int(round(num(v) * 1e6))
    word = lambda n, name: (lambda k: str(k[1]) if k is not None and len(k) > 1 else "")(kid(n, name))
    xy = lambda n, name: (lambda k: (nm(k[1]), nm(k[2])) if k is not None and len(k) > 2 else None)(kid(n, name))
    nets = {str(n[1]): str(n[2]) for n in root[1:] if isinstance(n, list) and len(n) > 2 and str(n[0]) == "net"}
    # a net is named by its number (declared at the top of the file) or, since KiCad 10, by its name itself
    net_of = lambda n: (lambda w: nets.get(w, w))(word(n, "net"))
    near = lambda a, b: abs(a[0] - b[0]) <= TOL and abs(a[1] - b[1]) <= TOL
    same_ends = lambda a, b: (near(a[0], b[0]) and near(a[1], b[1])) or (near(a[0], b[1]) and near(a[1], b[0]))
    apart = lambda a, b: min(sum(abs(p[0] - q[0]) + abs(p[1] - q[1]) for p, q in zip(a, o)) for o in (b, b[::-1]))
    vec = lambda p: pcbnew.VECTOR2I(int(p[0]), int(p[1]))
    done = {"footprints": 0, "tracks": 0, "vias": 0, "lines": 0, "zones": 0}

    # footprints, found by their place in the schematic, else by reference
    by_path, by_ref = {}, {}
    for fp in board.GetFootprints():
        by_path.setdefault(fp.GetPath().AsString(), fp)
        by_ref.setdefault(fp.GetReference(), fp)
    for n in root[1:]:
        if not isinstance(n, list) or not n or str(n[0]) not in ("footprint", "module"):
            continue
        ref = ""
        for k in n:
            if isinstance(k, list) and len(k) > 2 and ((str(k[0]) == "property" and str(k[1]) == "Reference") or (str(k[0]) == "fp_text" and str(k[1]) == "reference")):
                ref = str(k[2])
        fp = by_path.get(word(n, "path")) if word(n, "path") else None
        fp = fp or by_ref.get(ref)
        at = kid(n, "at")
        if fp is None or at is None or len(at) < 3:
            continue
        changed = False
        # the library the footprint is from, and the files of its 3D models (a plugin that copies a project's
        # libraries into it points the footprints at the copies)
        fpid = str(n[1]) if len(n) > 1 and not isinstance(n[1], list) else ""
        if fpid and fpid != fp.GetFPIDAsString():
            fp.SetFPIDAsString(fpid)
            changed = True
        files = [str(k[1]) for k in n if isinstance(k, list) and len(k) > 1 and str(k[0]) == "model" and not isinstance(k[1], list)]
        models = list(fp._kids()["models"])
        if len(files) == len(models):
            for m, f in zip(models, files):
                if f != m.m_Filename:
                    m.m_Filename = f
                    changed = True
        if word(n, "layer") in ("F.Cu", "B.Cu") and (word(n, "layer") == "B.Cu") != bool(fp.IsFlipped()):
            fp.Flip(fp.GetPosition(), False)
            changed = True
        pos, want = fp.GetPosition(), (nm(at[1]), nm(at[2]))
        if not near((pos.x, pos.y), want):
            fp.SetPosition(vec(want))
            changed = True
        turn = num(at[3]) if len(at) > 3 else 0.0
        if abs((fp.GetOrientationDegrees() - turn + 180) % 360 - 180) > 0.01:
            fp.SetOrientationDegrees(turn)
            changed = True
        done["footprints"] += changed

    def settle(live, new, same, far, move, make, count):
        """live: [(key, shape, item)], new: [(key, shape, node)].  What is where it was stays untouched; what is left on
        both sides is paired, nearest first, and moved; the rest is added (as a copy of a like item) or removed."""
        left = {}
        for key, shape, item in live:
            left.setdefault(key, []).append((shape, item))
        models = {key: rows[0][1] for key, rows in left.items()}
        extra = {}
        for key, shape, node in new:
            rows = left.get(key, [])
            hit = next((i for i, (have, _it) in enumerate(rows) if same(have, shape)), None)
            if hit is not None:
                rows.pop(hit)
            else:
                extra.setdefault(key, []).append((shape, node))
        for key, wanted in extra.items():
            rows = left.get(key, [])
            for shape, node in wanted:
                if rows:
                    i = min(range(len(rows)), key=lambda j: far(rows[j][0], shape))
                    move(rows.pop(i)[1], shape, node)
                else:
                    make(models.get(key), key, shape, node)
                done[count] += 1
        for rows in left.values():
            for _shape, item in rows:
                board.Remove(item)
                done[count] += 1

    def segments(head):
        for n in root[1:]:
            if isinstance(n, list) and n and str(n[0]) == head and xy(n, "start") and xy(n, "end"):
                yield n

    def width_of(n):
        k = kid(n, "width")
        return nm(k[1]) if k is not None and len(k) > 1 else 0

    # tracks
    def move_track(t, shape, node):
        t.SetStart(vec(shape[0]))
        t.SetEnd(vec(shape[1]))
        if width_of(node) > 0 and abs(t.GetWidth() - width_of(node)) > 1000:
            t.SetWidth(width_of(node))

    def make_track(model, key, shape, node):
        if model is not None:
            t = model.Duplicate()
        else:
            t = pcbnew.PCB_TRACK(board)
            t.SetLayer(board.GetLayerID(key[0]))
            net = board.FindNet(key[1]) if key[1] else None
            if net is not None:
                t.SetNet(net)
            t.SetWidth(width_of(node) or pcbnew.FromMM(0.25))
        board.Add(t)
        move_track(t, shape, node)

    live = [((word(t._node, "layer"), t.GetNetname()), ((t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y)), t)
            for t in board.GetTracks() if str(t._node[0]) == "segment"]
    new = [((word(n, "layer"), net_of(n)), (xy(n, "start"), xy(n, "end")), n) for n in segments("segment")]
    wide = {id(t): t for _k, _s, t in live}
    settle(live, new, same_ends, apart, move_track, make_track, "tracks")
    # a track that stayed where it was but was made wider or narrower
    for key, shape, node in new:
        w = width_of(node)
        for t in wide.values():
            if w > 0 and t._board is not None and (word(t._node, "layer"), t.GetNetname()) == key and abs(t.GetWidth() - w) > 1000 \
                    and same_ends(((t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y)), shape):
                t.SetWidth(w)
                done["tracks"] += 1
                break

    # vias
    def move_via(v, shape, node):
        v.SetPosition(vec(shape[0]))

    def make_via(model, key, shape, node):
        if model is None:
            return                                   # nothing to copy a via's drill and layers from
        v = model.Duplicate()
        board.Add(v)
        v.SetPosition(vec(shape[0]))

    live = [((t.GetNetname(),), ((t.GetPosition().x, t.GetPosition().y),), t) for t in board.GetTracks() if str(t._node[0]) == "via"]
    new = [((net_of(n),), (xy(n, "at"),), n) for n in root[1:] if isinstance(n, list) and n and str(n[0]) == "via" and xy(n, "at")]
    settle(live, new, lambda a, b: near(a[0], b[0]), lambda a, b: abs(a[0][0] - b[0][0]) + abs(a[0][1] - b[0][1]), move_via, make_via, "vias")

    # lines drawn on the board (the outline, mostly)
    def move_line(g, shape, node):
        g.SetStart(vec(shape[0]))
        g.SetEnd(vec(shape[1]))

    def make_line(model, key, shape, node):
        if model is None:
            return
        g = model.Duplicate()
        board.Add(g)
        move_line(g, shape, node)

    live = [((word(g._node, "layer"),), ((g.GetStart().x, g.GetStart().y), (g.GetEnd().x, g.GetEnd().y)), g)
            for g in board.GetDrawings() if str(g._node[0]) == "gr_line"]
    new = [((word(n, "layer"),), (xy(n, "start"), xy(n, "end")), n) for n in segments("gr_line")]
    settle(live, new, same_ends, apart, move_line, make_line, "lines")

    # zone outlines: the zones of one net and layer, in file order
    def zone_key(n):
        k = kid(n, "layers")
        return (word(n, "net_name"), tuple(str(x) for x in k[1:]) if k is not None else (word(n, "layer"),))

    def ring(n):
        poly = kid(n, "polygon")
        pts = kid(poly, "pts") if poly is not None else None
        out = [(nm(p[1]), nm(p[2])) for p in (pts or [])[1:] if isinstance(p, list) and len(p) > 2 and str(p[0]) == "xy"]
        return out[:-1] if len(out) > 1 and near(out[0], out[-1]) else out

    zones = {}
    for z in board.Zones():
        zones.setdefault(zone_key(z._node), []).append(z)
    for n in root[1:]:
        if not isinstance(n, list) or not n or str(n[0]) != "zone":
            continue
        rows = zones.get(zone_key(n), [])
        if not rows:
            continue
        z = rows.pop(0)
        want, have = ring(n), ring(z._node)
        if len(pcbnew._kids(z._node, "polygon")) != 1 or len(pcbnew._kids(n, "polygon")) != 1 or len(want) < 3:
            continue
        if len(want) == len(have) and all(near(a, b) for a, b in zip(want, have)):
            continue
        poly = pcbnew.SHAPE_POLY_SET()
        poly.AddOutline(pcbnew.SHAPE_LINE_CHAIN([vec(p) for p in want], True))
        z.SetOutline(poly)
        z.UnFill()
        done["zones"] += 1

    said = [("%d footprint%s changed" % (done["footprints"], "" if done["footprints"] == 1 else "s")) if done["footprints"] else "",
            ("%d track change%s" % (done["tracks"], "" if done["tracks"] == 1 else "s")) if done["tracks"] else "",
            ("%d via change%s" % (done["vias"], "" if done["vias"] == 1 else "s")) if done["vias"] else "",
            ("%d outline line%s changed" % (done["lines"], "" if done["lines"] == 1 else "s")) if done["lines"] else "",
            ("%d zone outline%s redrawn" % (done["zones"], "" if done["zones"] == 1 else "s")) if done["zones"] else ""]
    said = ", ".join(x for x in said if x)
    log.info("The board file the plugin wrote was carried into the board: %s", said or "nothing had changed")
    _wx_bridge_status("Board file read back: " + (said or "nothing had changed"))
    return done


def _wx_bridge_status(text):
    try:
        _call("ui.status", {"text": text, "nowait": True})
    except Exception:
        pass


def _offer_rewrites(fresh):
    """A schematic or another board of the project that the plugin rewrote as a file (desktop plugins that edit the
    schematic do it that way) is carried into the project's own document: the editor shows what changed and asks.
    Returns the files that were not taken, which are handed over as a download."""
    left = []
    for p in fresh:
        rel = os.path.relpath(p, PROJECT_DIR).replace(os.sep, "/")
        if rel.lower().endswith(".kicad_dru") and "/" not in rel:
            # the project's custom design rules, written as a file: they become the project's own rules, which the
            # design rule check follows, when the person agrees
            try:
                with open(p, encoding="utf-8") as fh:
                    text = fh.read()
                out = _call("project.saveRules", {"path": rel, "text": text}) or {}
            except Exception as e:
                out = {"error": str(e)}
            if out.get("applied") or out.get("unchanged"):
                if out.get("applied"):
                    log.info("%s: stored as the project's custom design rules", rel)
                continue
            if out.get("error"):
                log.warning("%s was written by the plugin but not stored in the project: %s", rel, out["error"])
            left.append(p)
            continue
        base = _state["given_text"].get(rel)
        if base is None:
            left.append(p)
            continue
        try:
            with open(p, encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError):
            left.append(p)
            continue
        if text == base:
            continue                                  # touched, not changed
        try:
            out = _call("project.rewriteDocument", {"path": rel, "base": base, "text": text}) or {}
        except Exception as e:
            out = {"error": str(e)}
        if out.get("applied"):
            _state["given_text"][rel] = text
            log.info("%s: %d change%s carried into the project", rel, len(out.get("changes") or []), "" if len(out.get("changes") or []) == 1 else "s")
        elif out.get("unchanged"):
            pass
        else:
            if out.get("error"):
                log.warning("%s was changed by the plugin but not carried into the project: %s", rel, out["error"])
            left.append(p)
    return left


def _hand_over_outputs():
    global _seen_files
    now = _tree(PROJECT_DIR)
    board = pcbnew._Host.board
    skip = {getattr(board, "_saved_as_from", None) or board.GetFileName()} if board is not None else set()
    fresh = sorted(p for p, sig in now.items() if _seen_files.get(p) != sig and p not in skip
                   and not any(part.startswith(".") for part in os.path.relpath(p, PROJECT_DIR).split(os.sep)))   # hidden files and folders are a plugin's own housekeeping
    _seen_files = now
    # a name a "save as" picker held the place of, which the plugin never wrote: nothing to hand over
    held = _state.get("placeholders") or ()
    fresh = [p for p in fresh if not (os.path.abspath(p) in held and os.path.getsize(p) == 0)]
    if not fresh or _bridge is None:
        return fresh
    fresh = _offer_libraries(fresh)
    fresh = _offer_rewrites(fresh)
    if not fresh:
        return []
    if len(fresh) == 1:
        with open(fresh[0], "rb") as fh:
            data = fh.read()
        name = os.path.basename(fresh[0])
    else:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for p in fresh:
                z.write(p, os.path.relpath(p, PROJECT_DIR))
        data = buf.getvalue()
        stem = os.path.splitext(os.path.basename(board.GetFileName()))[0] if board is not None else "output"
        name = f"{stem}-{package_name(_plugin['name'])[:40].strip('_') or 'plugin'}.zip"
    try:
        _call("files.save", {"filename": name, "base64": base64.b64encode(data).decode("ascii")})
        _note_handed(fresh)
    except Exception as e:
        print(f"Could not hand over {name}: {e}", file=sys.stderr)
    return fresh


# ----------------------------------------------------------------------------- what a plugin keeps between runs
#
# On the desktop a plugin's settings file, its window positions and its hidden notes folder beside the board are still
# there the next day.  This interpreter's file system is gone when the page closes, so those small files are kept in the
# plugin's own storage in the editor (per person, per plugin) and put back when the plugin starts: the files it changed
# in KiCad's settings folder, in the home folder and in its own folder, and its hidden files beside the board (those
# per project).  Output files are not kept: they are handed over as downloads.

_STATE_ONE, _STATE_ALL = 128 * 1024, 200 * 1024       # one file, and all files of one kind, as stored
_state = {"shipped": None, "saved": {}, "project": None, "warned": False, "given": set(), "given_text": {}, "handed": set(), "asked_back": set(), "board_file": None}


def _state_roots():
    return (("config", CONFIG_DIR), ("home", os.environ.get("HOME", ROOT + "/home")), ("plugin", PLUGIN_DIR))


def _state_walk(root, hidden_only=False):
    out = {}
    for base, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if d != "__pycache__" and not os.path.islink(os.path.join(base, d))]
        for n in names:
            p = os.path.join(base, n)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            if n.endswith(".pyc") or os.path.islink(p) or (hidden_only and not any(part.startswith(".") for part in rel.split("/"))):
                continue
            try:
                st = os.stat(p)
            except OSError:
                continue
            out[rel] = (st.st_mtime_ns, st.st_size)
    return out


def _state_pack(root, rels):
    """The files, newest and shallowest first, as far as the storage holds them."""
    import zlib
    files, used, dropped = {}, 0, []
    for rel in rels:
        try:
            with open(os.path.join(root, rel), "rb") as fh:
                data = fh.read(_STATE_ONE * 8 + 1)
        except OSError:
            continue
        body = base64.b64encode(zlib.compress(data, 6)).decode("ascii") if len(data) <= _STATE_ONE * 8 else None
        if body is None or len(body) > _STATE_ONE or used + len(body) > _STATE_ALL:
            dropped.append(rel)
            continue
        files[rel] = body
        used += len(body)
    return files, dropped


def _state_unpack(root, files):
    import zlib
    for rel, body in (files or {}).items():
        rel = os.path.normpath(str(rel)).replace("\\", "/")
        if rel.startswith("..") or rel.startswith("/"):
            continue
        try:
            _write(os.path.join(root, rel), zlib.decompress(base64.b64decode(body)))
        except Exception:
            pass                        # a damaged entry is one setting lost, not a reason to stop the plugin


def _restore_state():
    """At start: note what the plugin ships with, then put back what it changed the last time."""
    _state["shipped"] = {tag: _state_walk(root) for tag, root in _state_roots()}
    if _bridge is None:
        return
    try:
        kept = _call("storage.get", {"key": "py.state"}) or {}
    except Exception:
        return
    for tag, root in _state_roots():
        _state_unpack(root, (kept.get(tag) if isinstance(kept, dict) else None) or {})


def _restore_project_state(project_id):
    """When the board arrives: the plugin's hidden files beside it, kept for this project."""
    _state["project"] = "py.project." + str(project_id or "")[:120]
    if _bridge is None:
        return
    try:
        kept = _call("storage.get", {"key": _state["project"]}) or {}
    except Exception:
        return
    if isinstance(kept, dict):
        _state_unpack(PROJECT_DIR, kept.get("files") or {})
    try:
        handed = _call("storage.get", {"key": _handed_key()}) or []
        if isinstance(handed, list):
            _state["handed"] |= {str(r) for r in handed[:200]}
    except Exception:
        pass


def _save_state():
    """After the plugin worked: keep what it changed, if anything changed since the last time this ran."""
    if _bridge is None or _state["shipped"] is None:
        return
    order = lambda sigs: sorted(sigs, key=lambda rel: (rel.count("/"), -sigs[rel][0], rel))
    try:
        now = {tag: _state_walk(root) for tag, root in _state_roots()}
        changed = {tag: {rel: sig for rel, sig in now[tag].items() if _state["shipped"][tag].get(rel) != sig} for tag in now}
        dropped = []
        if changed != _state["saved"].get("own"):
            kept = {}
            for tag, root in _state_roots():
                kept[tag], lost = _state_pack(root, order(changed[tag]))
                dropped += lost
            _call("storage.set", {"key": "py.state", "value": kept})
            _state["saved"]["own"] = changed
        if _state["project"]:
            # beside the board: the plugin's hidden housekeeping first, then the other small files it wrote there (a
            # saved block, a preset), which on the desktop would still lie in the project folder the next day.  The
            # design's own files come from the editor each time and are never kept here.
            hidden = _state_walk(PROJECT_DIR)
            for rel in list(hidden):
                if rel in _state["given"]:
                    del hidden[rel]
            if hidden != _state["saved"].get("project"):
                is_hidden = lambda rel: any(part.startswith(".") for part in rel.split("/"))
                files, lost = _state_pack(PROJECT_DIR, sorted(order(hidden), key=lambda rel: not is_hidden(rel)))
                lost = [rel for rel in lost if is_hidden(rel)]          # outputs too large to keep were handed over anyway
                # a hidden folder is a plugin's notes about one piece of work (a backup and the list of what is in
                # it): kept whole or not at all, so the plugin never finds half of it the next day
                for top in {rel.split("/")[0] for rel in lost if "/" in rel and rel.split("/")[0].startswith(".")}:
                    for rel in [r for r in files if r.split("/")[0] == top]:
                        del files[rel]
                        lost.append(rel)
                dropped += lost
                _call("storage.set", {"key": _state["project"], "value": {"files": files}})
                _state["saved"]["project"] = hidden
        if dropped and not _state["warned"]:
            _state["warned"] = True
            log.warning("These files of the plugin are too large to keep between runs: %s", ", ".join(dropped[:6]))
    except Exception as e:
        if not _state["warned"]:
            _state["warned"] = True
            log.warning("The plugin's settings could not be kept for the next run: %s", e)


# ----------------------------------------------------------------------------- running an action

# ----------------------------------------------------------------------------- fabrication outputs
#
# pcbnew's PLOT_CONTROLLER, EXCELLON_WRITER and PLACE_FILE_EXPORTER write files; here the editor's own writers make them
# (the ones behind File → Fabrication Outputs) from the board as it stands, and the files land where the plugin asked,
# in this interpreter's file system, so the plugin can go on to zip or post-process them as it does on the desktop.

def _out_dir(directory):
    d = str(directory or "")
    if not os.path.isabs(d):
        d = os.path.join(PROJECT_DIR, d)
    os.makedirs(d, exist_ok=True)
    return d


def _board_stem():
    b = pcbnew._Host.board
    return os.path.splitext(os.path.basename(b.GetFileName() if b is not None else "board"))[0] or "board"


def _plot_name(suffix, ext):
    """BuildPlotFileName: the board's name, a dash and the suffix with the characters a file name cannot hold made '_'."""
    import re
    suffix = re.sub(r'[\\/:*?"<>|%.]', "_", str(suffix or "").strip())
    return f"{_board_stem()}-{suffix}{ext}" if suffix else f"{_board_stem()}{ext}"


def _fab_plot_page(board, opts, layers, suffix, fmt):
    """PostScript, DXF, PDF and SVG: the editor's File → Plot writers, one file holding the layers asked for."""
    import base64
    flush()
    names = [pcbnew._layer_name(l) for l in layers]
    if not names:
        return ""
    common = names[1:] + [pcbnew._layer_name(l) for l in (opts.get("PlotOnAllLayersSequence") or []) if pcbnew._layer_name(l) not in names]
    scale = opts.get("Scale")
    res = _call("fab.plot", {
        "format": int(fmt), "layers": names[:1], "commonLayers": common, "mirror": bool(opts.get("Mirror")), "negative": bool(opts.get("Negative")),
        "plotFrameRef": bool(opts.get("PlotFrameRef")), "drillMarks": int(opts.get("DrillMarksType") or 0),
        "blackAndWhite": bool(opts.get("BlackAndWhite", True)), "plotReference": bool(opts.get("PlotReference", True)),
        "plotValue": bool(opts.get("PlotValue", True)), "useAuxOrigin": bool(opts.get("UseAuxOrigin")),
        "scale": float(scale) if isinstance(scale, (int, float)) else 1.0, "autoScale": bool(opts.get("AutoScale")),
        "svgPrecision": 4 if getattr(pcbnew._Host, "kicad6", False) else int(opts.get("SvgPrecision") or 4), "svgFitPageToBoard": bool(opts.get("SvgFitPageToBoard")),
        "sketchPadsOnFab": bool(opts.get("SketchPadsOnFabLayers")), "plotPadNumbers": bool(opts.get("PlotPadNumbers")),
        "sketchDnpOnFab": bool(opts.get("SketchDNPFPsOnFabLayers", True)), "hideDnpOnFab": bool(opts.get("HideDNPFPsOnFabLayers")),
        "crossoutDnpOnFab": bool(opts.get("CrossoutDNPFPsOnFabLayers", True)), "subtractMaskFromSilk": bool(opts.get("SubtractMaskFromSilk")),
        "dxfPolygonMode": bool(opts.get("DXFPlotPolygonMode", True)), "dxfImperial": int(opts.get("DXFPlotUnits") or 0) == 0,
        "a4Output": bool(opts.get("A4Output")), "fineScaleX": float(opts.get("FineScaleAdjustX") or 1.0),
        "fineScaleY": float(opts.get("FineScaleAdjustY") or 1.0), "widthAdjust": float(opts.get("WidthAdjust") or 0) / 1e6}) or {}
    for w in res.get("warnings") or []:
        log.warning("plot: %s", w)
    if not res.get("base64"):
        if res.get("missing"):
            return ""                                           # a layer this board does not have
        raise pcbnew.WebUnsupported("Plotting without a board open")
    ext = os.path.splitext(res.get("name") or "")[1] or ".plt"
    path = os.path.join(_out_dir(opts.get("OutputDirectory")), _plot_name(suffix, ext))
    data = base64.b64decode(res["base64"])
    if int(fmt) == pcbnew.PLOT_FORMAT_SVG and getattr(pcbnew._Host, "kicad6", False):
        data = _svg_kicad6(data, opts.get("SvgPrecision"))
    _write(path, data)
    return path


def _svg_kicad6(data, precision):
    """An SVG plot in the units KiCad 6 wrote: whole numbers of 10^-precision mm (nanometres at the default 6), where
    KiCad 7 and later write millimetres with decimals.  A plugin that has used an interface only KiCad 6 has (see
    pcbnew._Host.kicad6) goes on to read or re-frame the drawing in those units, so the drawing is given to it that
    way: the same shapes inside one group that scales them, and the viewBox in the same units."""
    import re
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return data
    # KiCad 6's SetSvgPrecision took (precision, use inches) and its default was 6; a bare 4 is this shim's KiCad 7 default
    given = precision[0] if isinstance(precision, (tuple, list)) and precision else None
    k = 10 ** (int(given) if isinstance(given, int) and 3 <= given <= 6 else 6)
    head = re.search(r"<svg\b[^>]*>", text)
    tail = text.rfind("</svg>")
    if not head or tail < 0:
        return data
    tag = re.sub(r'viewBox="([^"]*)"', lambda m: 'viewBox="' + " ".join(str(int(round(float(v) * k))) for v in m.group(1).replace(",", " ").split()) + '"', head.group(0))
    return (text[:head.start()] + tag + f'\n<g transform="scale({k} {k})">' + text[head.end():tail] + "</g>\n" + text[tail:]).encode("utf-8")


def _fab_plot(board, opts, layers, suffix, fmt, sheet_desc):
    if fmt in (pcbnew.PLOT_FORMAT_SVG, pcbnew.PLOT_FORMAT_PDF, pcbnew.PLOT_FORMAT_DXF, pcbnew.PLOT_FORMAT_POST):
        return _fab_plot_page(board, opts, layers, suffix, fmt)
    if fmt != pcbnew.PLOT_FORMAT_GERBER:
        raise pcbnew.WebUnsupported("Plotting to HPGL (KiCad itself no longer writes it; Gerber, PostScript, DXF, PDF and SVG are available)")
    flush()                                                    # what the plugin changed so far is part of the plot
    names = [pcbnew._layer_name(l) for l in layers]
    if not names:
        return ""
    common = names[1:] + [pcbnew._layer_name(l) for l in (opts.get("PlotOnAllLayersSequence") or []) if pcbnew._layer_name(l) not in names]
    res = _call("fab.gerbers", {
        "layers": names[:1], "commonLayers": common, "useProtelExtensions": bool(opts.get("UseGerberProtelExtensions")),
        "useGerberX2": bool(opts.get("UseGerberX2format", True)), "useAuxOrigin": bool(opts.get("UseAuxOrigin")),
        "precision": 5 if opts.get("GerberPrecision") == 5 else 6, "plotReference": bool(opts.get("PlotReference", True)),
        "plotValue": bool(opts.get("PlotValue", True)), "subtractMaskFromSilk": bool(opts.get("SubtractMaskFromSilk")),
        "sketchDnpOnFab": bool(opts.get("SketchDNPFPsOnFabLayers", True)), "hideDnpOnFab": bool(opts.get("HideDNPFPsOnFabLayers")),
        "crossoutDnpOnFab": bool(opts.get("CrossoutDNPFPsOnFabLayers", True))}) or {}
    files = res.get("files") or []
    if not files:
        if res.get("missing"):
            return ""                                           # a layer this board does not have: the desktop writes nothing useful either
        raise pcbnew.WebUnsupported("Plotting without a board open")
    for w in res.get("warnings") or []:
        log.warning("plot: %s", w)
    ext = os.path.splitext(files[0]["name"])[1] or ".gbr"
    path = os.path.join(_out_dir(opts.get("OutputDirectory")), _plot_name(suffix, ext))
    _write(path, files[0]["text"].encode("utf-8"))
    return path


_ZEROS = {0: "decimal", 1: "suppress_leading", 2: "suppress_trailing", 3: "keep"}


def _fab_drill_files(opts, kind="excellon"):
    if kind != "excellon":
        raise pcbnew.WebUnsupported("Drill files in Gerber X2 format (Excellon drill files are available)")
    off = opts.get("offset")
    return (_call("fab.drill", {
        "metric": bool(opts.get("metric", True)), "zeros": _ZEROS.get(int(opts.get("zerosFormat") or 0), "decimal"), "merge": bool(opts.get("mergeNPTH")),
        "minimalHeader": bool(opts.get("minimalHeader")), "mirrorY": bool(opts.get("mirror")), "ovalMode": "route" if opts.get("routeMode", True) else "g85",
        "useAuxOrigin": bool(off is not None and (off.x or off.y))}) or {}).get("files") or []


def _fab_drill(board, kind, opts, directory, drill, map_file):
    flush()
    if drill:
        d = _out_dir(directory)
        for f in _fab_drill_files(opts, kind):
            _write(os.path.join(d, f["name"]), f["text"].encode("utf-8"))
    if map_file:
        log.warning("drill map files are not written in the web editor; the drill files are")
    return True


def _fab_report(board, opts, path):
    flush()
    lines = [f"Drill report for {_board_stem()}.kicad_pcb", "Created by the Junction web editor", ""]
    for f in _fab_drill_files(opts):
        lines.append(f"Drill file '{f['name']}' contains")
        lines.append("    " + ("plated through holes:" if "NPTH" not in f["name"] else "unplated through holes:"))
        lines.append("    =============================================================")
        for i, t in enumerate(f.get("tools") or []):
            lines.append(f"    T{i + 1}  {t['d']:.3f}mm  {t['d'] / 25.4:.4f}\"  ({t['count']} hole{'s' if t['count'] != 1 else ''})")
        lines.append(f"\n    Total {'plated' if 'NPTH' not in f['name'] else 'unplated'} holes count {f.get('holes', 0)}\n")
    p = str(path) if os.path.isabs(str(path)) else os.path.join(PROJECT_DIR, str(path))
    _write(p, "\n".join(lines).encode("utf-8"))
    return True


def _fab_positions(board, opts):
    flush()
    side = "both" if opts.get("top", True) and opts.get("bottom", True) else ("front" if opts.get("top", True) else "back")
    res = _call("fab.positions", {"side": side, "smdOnly": bool(opts.get("smdOnly")), "excludeThroughHole": bool(opts.get("excludeTH")),
                                   "excludeDnp": bool(opts.get("excludeDNP")), "useAuxOrigin": bool(opts.get("useAuxOrigin")),
                                   "negateBottomX": bool(opts.get("negateBottomX"))}) or {}
    if opts.get("metric", True):
        return res.get("csv", "") if opts.get("csv", True) else res.get("ascii", "")
    q = lambda v: '"' + str(v).replace('"', '""') + '"'
    rows = ["Ref,Val,Package,PosX,PosY,Rot,Side"]
    for r in res.get("rows") or []:
        rows.append(",".join([q(r["ref"]), q(r["value"]), q(r["package"]), f"{r['x'] / 25.4:.4f}", f"{r['y'] / 25.4:.4f}", f"{r['rotation']:.4f}", r["side"]]))
    return "\n".join(rows) + "\n"


def _install_fabrication():
    f = pcbnew._Fabrication
    f.plot, f.drill, f.report, f.positions = _fab_plot, _fab_drill, _fab_report, _fab_positions


def _main_button(top):
    """The button a person would press to make a window do its work: its default button, else OK/Apply/Yes, else the
    first one that is not Cancel, Close or Help."""
    buttons = []

    def walk(w):
        for c in getattr(w, "_wx_children", []):
            if isinstance(c, wx.Button) and c.IsEnabled() and c.IsShown():
                buttons.append(c)
            walk(c)
    walk(top)
    default = getattr(top, "_wx_default", None)
    pick = default if default in buttons else next((b for b in buttons if b.GetId() in (wx.ID_OK, wx.ID_APPLY, wx.ID_YES)), None)
    if pick is None:
        pick = next((b for b in buttons if b.GetId() not in (wx.ID_CANCEL, wx.ID_CLOSE, wx.ID_NO, wx.ID_HELP)
                     and str(b.GetLabel()).strip().lower() not in ("cancel", "close", "exit", "quit", "help", "about", "…", "...", "browse")), None)
    return pick


_pressed_in_modal = []


def press_modal(dialog):
    """For the test harness: a dialog the plugin waits on (ShowModal) gets its main button pressed while it is open,
    so the work behind it runs, as press_default does for windows a plugin leaves open.  Returns the dialog's code."""
    pick = _main_button(dialog)
    if pick is None:
        return wx.ID_OK
    _pressed_in_modal.append(str(pick.GetLabel()))
    pick._wx_clicked()
    wx._run_later()
    return wx.ID_OK


def press_default():
    """For the test harness, where nobody is there to click: press the main button of every window a plugin left open
    (its default button, else the first one that is not Cancel or Close), so the work behind the dialog runs too.
    Returns the labels pressed (those pressed inside modal dialogs first), as JSON."""
    pressed = list(_pressed_in_modal)
    del _pressed_in_modal[:]
    error = None
    _running[0] += 1
    try:
        for top in list(wx._top_windows):
            if not getattr(top, "_wx_visible", False):
                continue
            wx._run_later()
            pick = _main_button(top)
            if pick is not None:
                pressed.append(str(pick.GetLabel()))
                pick._wx_clicked()
        wx._run_later()
        flush()
        _export_outputs()
    except SystemExit:
        pass
    except BaseException as e:
        error = _describe(e)
        traceback.print_exc()
    finally:
        _running[0] -= 1
    return json.dumps({"pressed": pressed, "error": error})


def wizard_op(index, req):
    """A request of the footprint editor's wizard dialog to the footprint wizard registered as action `index`
    (kicad_wizard.web_op).  Returns JSON: the wizard's state, or {"error": "..."}."""
    plugin = _actions[index] if 0 <= index < len(_actions) else None
    if plugin is None or not hasattr(plugin, "wizard"):
        return json.dumps({"error": "the plugin has no such footprint wizard"})
    import kicad_wizard
    try:
        return json.dumps(kicad_wizard.web_op(plugin.wizard, json.loads(req) if isinstance(req, str) else {}))
    except BaseException as e:
        traceback.print_exc()
        return json.dumps({"error": _describe(e)})


def run_action(index):
    """Run one registered ActionPlugin.  Returns JSON: {"ok": true} or {"error": "..."}."""
    global _seen_files
    if not (0 <= index < len(_actions)):
        return json.dumps({"error": "the plugin has no such action"})
    plugin = _actions[index]
    _label[0] = str(getattr(plugin, "name", "") or "edit")[:80]
    _refill_note[0] = False
    _saved_as[0] = None
    error = None
    _running[0] += 1
    try:
        load_board()
        _seen_files = _tree(PROJECT_DIR)
        _state["asked_back"] = set()
        plugin.Run()
        wx._flush_log()
        _carry_board_file()
    except SystemExit:
        pass
    except BaseException as e:
        error = _describe(e)
        traceback.print_exc()
    finally:
        _running[0] -= 1
    try:
        flush()
        _export_outputs()
    except BaseException as e:
        if error is None:
            error = _describe(e)
        traceback.print_exc()
    out = {"ok": error is None}
    if error:
        out["error"] = error
    if _saved_as[0]:
        # the copy this interpreter holds is the plugin's new file now; the editor's board is read again before it is used
        b = pcbnew._Host.board
        if b is not None:
            b._modified = False
        _stale[0] = True
        out["note"] = ("The plugin saved its result as a board file of its own, %s, which is handed over with its other files. "
                       "The open board was left as it was, as a “save as” on the desktop leaves the file you opened."
                       % os.path.relpath(_saved_as[0], PROJECT_DIR).replace(os.sep, "/"))
    elif _refill_note[0]:
        out["note"] = ("Zones were filled here, by the web editor's own filler. KiCad on the desktop fills them again with its own "
                       "(Edit → Fill All Zones, B), which can differ slightly at the edges."
                       if _refill_note[0] == "filled" else
                       "Zone fills were cleared for the changed zones. Edit → Fill All Zones (B) refills them.")
    return json.dumps(out)
