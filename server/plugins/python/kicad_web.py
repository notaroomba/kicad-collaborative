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


def _install_finders():
    if not any(isinstance(f, _WxFinder) for f in sys.meta_path):
        sys.meta_path.append(_WxFinder())


# ----------------------------------------------------------------------------- the environment a plugin expects

def _patch_threads():
    """There are no threads in the browser's Python: a thread a plugin starts runs to its end at once."""
    def start(self):
        self._kc_alive = True
        try:
            self.run()
        except Exception:
            traceback.print_exc()
        finally:
            self._kc_alive = False

    threading.Thread.start = start
    threading.Thread.join = lambda self, timeout=None: None
    threading.Thread.is_alive = lambda self: getattr(self, "_kc_alive", False)
    threading.Thread.isAlive = threading.Thread.is_alive


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
        parts = str(args).split()
        return (os.path.basename(parts[0]).lower() if parts else ""), parts[1:]

    class Done:
        def __init__(self, args):
            self.args, self.returncode, self.stdout, self.stderr, self.pid = args, 0, b"", b"", 0

        def communicate(self, *a, **k):
            return self.stdout, self.stderr

        def wait(self, *a, **k):
            return 0

        def poll(self):
            return 0

        def kill(self):
            pass

        terminate = kill

        def check_returncode(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def launch(args, *a, **k):
        name, rest = program(args)
        if name in _OPENERS:
            for r in rest:
                if not r.startswith(("-", "/c", "/C")) and r not in ('""',):
                    _open_target(r)
                    break
            return Done(args)
        raise pcbnew.WebUnsupported(f"Running another program ({name or 'a command'}): there are no other programs in the browser")

    subprocess.Popen = launch
    subprocess.run = launch
    subprocess.call = lambda args, *a, **k: launch(args).returncode
    subprocess.check_call = subprocess.call
    subprocess.check_output = lambda args, *a, **k: launch(args).stdout
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


def _on_register(plugin):
    if plugin not in _actions:
        _actions.append(plugin)


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
    pcbnew._Host.plugin_dir = PLUGIN_DIR
    pcbnew._Host.config_dir = CONFIG_DIR
    pcbnew._Host.on_register = _on_register
    pcbnew._Host.refresh = flush
    if bridge is not None:
        _install_fabrication()
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
    try:
        base = f"{PLUGIN_DIR}/{pkg}"
        if os.path.exists(f"{base}/__init__.py"):
            pcbnew.LoadPluginModule(PLUGIN_DIR, pkg, pkg)
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
    return json.dumps(describe())


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
    if _running[0] or _event_depth[0]:
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
