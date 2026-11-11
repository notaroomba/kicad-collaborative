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
        run_thread(self, self.run)

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
            wx.CallAfter(lambda: run_thread(worker, worker.run))

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
            from pyodide.ffi import create_once_callable
            wx._kc().later(create_once_callable(lambda: wx._call(fire)), int(max(0.0, float(self.interval)) * 1000))
            return
        start(self)

    def timer_run(self):
        if not self.finished.is_set():
            self.function(*self.args, **self.kwargs)
        self.finished.set()

    threading.Timer.start = timer_start
    threading.Timer.run = timer_run
    # Nothing else runs while this code runs, so waiting for another thread to signal can only time out.
    threading.Event.wait = lambda self, timeout=None: self.is_set()
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
        argv, path, out = sys.argv, list(sys.path), sys.stdout
        capture = k.get("capture_output") or k.get("stdout") == subprocess.PIPE
        buf = io.StringIO()
        if capture:
            sys.stdout = buf
        cwd = os.getcwd()
        try:
            if k.get("cwd"):
                os.chdir(str(k["cwd"]))
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
            sys.argv, sys.path[:], sys.stdout = argv, path, out
            try:
                os.chdir(cwd)
            except OSError:
                pass
        text = buf.getvalue()
        done.stdout = text if (k.get("text") or k.get("universal_newlines") or k.get("encoding")) else text.encode("utf-8")
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
    for stub in ("/usr/bin/kicad-cli", "/usr/bin/git"):
        try:
            if not os.path.exists(stub):
                _write(stub, b"#!/bin/sh\n")
                os.chmod(stub, 0o755)
        except OSError:
            pass

    # Nothing can connect to this interpreter: a plugin that listens on a local port (to talk to a helper program or
    # to a page in the browser) is told so at once instead of waiting for a caller that cannot come.
    import socket
    import socketserver

    def no_listen(self, *a, **k):
        raise OSError(95, "listening for connections is not possible in the browser")

    def no_serve(self, *a, **k):
        raise pcbnew.WebUnsupported("Serving files to another program over a local network port")

    socket.socket.accept = no_listen
    socketserver.BaseServer.serve_forever = no_serve
    socketserver.BaseServer.handle_request = no_serve

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
    sys.platform = "linux"
    sys.executable = "/usr/bin/python3"
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
    return json.dumps(sorted(wanted))


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
    if bridge is not None:
        _install_fabrication()
    import kicad_net
    kicad_net.install((lambda request: _call("net.fetch", request)) if bridge is not None else None)
    pcbnew._Host.focus = _focus
    wx._bridge = _WxBridge() if bridge is not None else None
    wx._after_event = _after_event
    pkg = install_files(identifier, files)
    _plugin.update(identifier=identifier, package=pkg, name=name or identifier)
    if PLUGIN_DIR not in sys.path:
        sys.path.insert(0, PLUGIN_DIR)
    os.chdir(PROJECT_DIR)
    _load_error = None
    import logging
    logging.basicConfig(level=logging.DEBUG if os.environ.get("KICAD_WEB_DEBUG") else logging.WARNING, format="%(levelname)s %(name)s: %(message)s", force=True)
    base = f"{PLUGIN_DIR}/{pkg}"
    ipc = _ipc_manifest(base)
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
                    "category": str(getattr(p, "category", "") or "")[:80], "button": bool(getattr(p, "show_toolbar_button", False)), "icon": _icon(p)})
    return {"actions": out, "error": _load_error, "missing": {"pcbnew": sorted(pcbnew._missing), "wx": sorted(wx._missing)}}


# ----------------------------------------------------------------------------- talking to the editor

def _call(method, args=None):
    """One request to the editor; blocks until it answers.  Returns the decoded result."""
    if _bridge is None:
        return None
    out = _bridge(method, json.dumps(args or {}))
    return json.loads(out) if isinstance(out, str) and out else out


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
    project = {}
    for f in info.get("files") or []:
        rel = os.path.normpath(str(f.get("path") or "")).replace("\\", "/")
        if not rel or rel.startswith("..") or rel.startswith("/"):
            continue
        _write(f"{PROJECT_DIR}/{rel}", str(f.get("text") or "").encode("utf-8"))
        if rel.endswith(".kicad_pro") and (not project or os.path.splitext(rel)[0] == os.path.splitext(os.path.basename(path))[0]):
            try:
                project = json.loads(f.get("text") or "{}")
            except ValueError:
                pass
    pcbnew._Host.project = project if isinstance(project, dict) else {}
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
        _refill_note[0] = True
    return out


_label = ["edit"]
_refill_note = [False]
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
            _export_outputs()
    except Exception:
        traceback.print_exc()
    finally:
        _event_depth[0] -= 1


# ----------------------------------------------------------------------------- files a plugin writes

def _tree(root):
    out = {}
    for base, _dirs, names in os.walk(root):
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
    """Whatever the plugin wrote into the project folder is offered to the person as a download."""
    global _seen_files
    now = _tree(PROJECT_DIR)
    board = pcbnew._Host.board
    skip = {board.GetFileName()} if board is not None else set()
    fresh = sorted(p for p, sig in now.items() if _seen_files.get(p) != sig and p not in skip and not os.path.basename(p).startswith("."))
    _seen_files = now
    if not fresh or _bridge is None:
        return fresh
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
    except Exception as e:
        print(f"Could not hand over {name}: {e}", file=sys.stderr)
    return fresh


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


def _fab_plot(board, opts, layers, suffix, fmt, sheet_desc):
    if fmt != pcbnew.PLOT_FORMAT_GERBER:
        kind = {pcbnew.PLOT_FORMAT_SVG: "SVG", pcbnew.PLOT_FORMAT_PDF: "PDF", pcbnew.PLOT_FORMAT_DXF: "DXF", pcbnew.PLOT_FORMAT_POST: "PostScript",
                pcbnew.PLOT_FORMAT_HPGL: "HPGL"}.get(fmt, "that format")
        raise pcbnew.WebUnsupported(f"Plotting to {kind} from a plugin (File → Plot makes {kind} files; plugins can plot Gerbers)")
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
    path = os.path.join(_out_dir(opts.get("OutputDirectory")), f"{_board_stem()}-{suffix}{ext}" if suffix else f"{_board_stem()}{ext}")
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
    lines = [f"Drill report for {_board_stem()}.kicad_pcb", "Created by the KiCad Collaborative web editor", ""]
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


def press_default():
    """For the test harness, where nobody is there to click: press the main button of every window a plugin left open
    (its default button, else the first one that is not Cancel or Close), so the work behind the dialog runs too.
    Returns the labels pressed, as JSON."""
    pressed = []
    error = None
    _running[0] += 1
    try:
        for top in list(wx._top_windows):
            if not getattr(top, "_wx_visible", False):
                continue
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
            if pick is not None:
                pressed.append(str(pick.GetLabel()))
                pick._wx_clicked()
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


def run_action(index):
    """Run one registered ActionPlugin.  Returns JSON: {"ok": true} or {"error": "..."}."""
    global _seen_files
    if not (0 <= index < len(_actions)):
        return json.dumps({"error": "the plugin has no such action"})
    plugin = _actions[index]
    _label[0] = str(getattr(plugin, "name", "") or "edit")[:80]
    _refill_note[0] = False
    error = None
    _running[0] += 1
    try:
        load_board()
        _seen_files = _tree(PROJECT_DIR)
        plugin.Run()
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
    if _refill_note[0]:
        out["note"] = "Zone fills were cleared for the changed zones. Edit → Fill All Zones (B) refills them."
    return json.dumps(out)
