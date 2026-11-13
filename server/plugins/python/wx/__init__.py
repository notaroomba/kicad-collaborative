# wx — the part of wxPython KiCad plugins draw their dialogs with, for the web editor.
#
# On the desktop a plugin's dialog is a native window.  Here every widget is an HTML element in
# the plugin's own sandboxed frame, sizers are flex and grid containers, and a top-level window is
# shown by the editor as a floating dialog around that frame.  ShowModal() really blocks: the
# Python stack is suspended until the dialog ends (WebAssembly stack switching), so plugin code
# written for the desktop runs unchanged.
#
# Without a browser (the test harness) the same code runs against stand-in elements, and modal
# dialogs are answered by `wx._headless_modal`.

import base64 as _b64
import os as _os
import re as _re
import sys as _sys

try:
    import js as _js
    _DOM = hasattr(_js, "document") and hasattr(_js, "__kcWx")
except ImportError:
    _js = None
    _DOM = False


def _kc():
    """The frame's window services (pyruntime.ts).  Looked up here, at module level: inside a class body Python would
    mangle the name's two leading underscores."""
    return getattr(_js, "__kcWx")


_missing = set()           # names a plugin used that this module only stands in for
_headless_modal = None     # headless: callable(dialog) -> return code
_headless_main = None      # headless: callable() run by App.MainLoop of a plugin that is its own program
_process_mode = False      # the running plugin is its own program (KiCad's IPC kind): App.MainLoop blocks while its windows are open
_in_mainloop = [0]
_bridge = None             # set by the runtime: host calls (confirm, prompt, pick, status, toast)
_before_event = None       # set by the runtime: called before each handler (brings the board up to date with the editor)
_filters = []              # wx.EventFilter objects, see EvtHandler.AddFilter
_editor = {}               # set by the runtime: what the board editor's window does (its plugin menu, undo, its keys)
_after_event = None        # set by the runtime: called after each handler (commits board changes)


class _Null:
    """What a call on a widget the web has no form for returns: it accepts anything and is nothing."""
    __slots__ = ()

    def __call__(self, *a, **k):
        return self

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return self

    def __bool__(self):
        return False

    def __iter__(self):
        return iter(())

    def __len__(self):
        return 0

    def __int__(self):
        return 0

    __index__ = __int__

    def __float__(self):
        return 0.0

    def __str__(self):
        return ""

    def __repr__(self):
        return "<wx: nothing>"

    def __eq__(self, o):
        return o is None or isinstance(o, _Null)

    def __hash__(self):
        return 0

    def __getitem__(self, i):
        if isinstance(i, int) and i > 8:
            raise IndexError(i)
        return self

    def __add__(self, o):
        return o

    __radd__ = __add__

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


_NULL = _Null()


class _Zero(int):
    """An unknown constant: zero, and callable in case it was a function after all."""

    def __call__(self, *a, **k):
        return _NULL

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Zero(0)


class _Thing:
    """A desktop-only helper object (pens, cursors, accelerator tables, …): constructed and ignored."""

    def __init__(self, *a, **k):
        pass

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return _NULL

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    IsOk = Ok = lambda self: True


# ----------------------------------------------------------------------------- elements

class _Style:
    def __init__(self):
        self.__dict__["_p"] = {}

    def setProperty(self, k, v):
        self._p[k] = v

    def removeProperty(self, k):
        self._p.pop(k, None)

    def __setattr__(self, k, v):
        self._p[k] = v

    def __getattr__(self, k):
        return self._p.get(k, "")


class _ClassList:
    def __init__(self):
        self._s = set()

    def add(self, *n):
        self._s.update(n)

    def remove(self, *n):
        self._s.difference_update(n)

    def toggle(self, n, on=None):
        (self._s.add if (on if on is not None else n not in self._s) else self._s.discard)(n)


class _FakeEl:
    """Stands in for a DOM element when there is no browser."""

    def __init__(self, tag):
        self.tagName = tag.upper()
        self.style = _Style()
        self.classList = _ClassList()
        self.children = []
        self.parentNode = None
        self.value = ""
        self.checked = False
        self.disabled = False
        self.hidden = False
        self.textContent = ""
        self.selectedIndex = -1
        self.innerHTML = ""
        self._listeners = {}
        self._attrs = {}

    def appendChild(self, c):
        if c.parentNode is not None and c in c.parentNode.children:
            c.parentNode.children.remove(c)
        self.children.append(c)
        c.parentNode = self
        return c

    def insertBefore(self, c, ref):
        self.appendChild(c)

    def removeChild(self, c):
        if c in self.children:
            self.children.remove(c)
            c.parentNode = None

    def remove(self):
        if self.parentNode is not None:
            self.parentNode.removeChild(self)

    def replaceChildren(self, *kids):
        for c in list(self.children):
            self.removeChild(c)
        for c in kids:
            self.appendChild(c)

    def addEventListener(self, name, fn, *_):
        self._listeners.setdefault(name, []).append(fn)

    def setAttribute(self, k, v):
        self._attrs[k] = v

    def getAttribute(self, k):
        return self._attrs.get(k)

    def removeAttribute(self, k):
        self._attrs.pop(k, None)

    def focus(self):
        pass

    def select(self):
        pass

    def scrollIntoView(self, *_):
        pass

    def click(self):
        for fn in self._listeners.get("click", []):
            fn(None)


def _el(tag, cls=None):
    e = _js.document.createElement(tag) if _DOM else _FakeEl(tag)
    if cls:
        e.className = cls
    return e


def _listen(el, name, fn):
    """Call `fn(dom event)` on a DOM event, in a way that lets the handler open a modal dialog."""
    if _DOM:
        from pyodide.ffi import create_proxy
        el.addEventListener(name, _kc().promising(create_proxy(fn)))
    else:
        el.addEventListener(name, fn)


def _once(fn):
    """A callback for JavaScript to call once (a timer).  Unlike pyodide's create_once_callable it is a Python proxy, so
    the caller can enter it with callPromising and the callback may block on the editor (read the board, open a dialog)."""
    from pyodide.ffi import create_proxy
    box = []

    def run(*a):
        try:
            return fn(*a)
        finally:
            try:
                box[0].destroy()
            except Exception:
                pass
    box.append(create_proxy(run))
    return box[0]


def _wait(promise):
    """Block this Python stack on a JavaScript promise."""
    from pyodide.ffi import run_sync
    return run_sync(promise)


# ----------------------------------------------------------------------------- constants

ID_ANY = -1
ID_NONE = -3
ID_LOWEST = 4999
(ID_OPEN, ID_CLOSE, ID_NEW, ID_SAVE, ID_SAVEAS, ID_REVERT, ID_EXIT, ID_UNDO, ID_REDO, ID_HELP, ID_PRINT, ID_PRINT_SETUP,
 ID_PAGE_SETUP, ID_PREVIEW, ID_ABOUT) = range(5000, 5015)
(ID_CUT, ID_COPY, ID_PASTE, ID_CLEAR, ID_FIND, ID_DUPLICATE, ID_SELECTALL, ID_DELETE, ID_REPLACE, ID_REPLACE_ALL, ID_PROPERTIES) = range(5030, 5041)
(ID_OK, ID_CANCEL, ID_APPLY, ID_YES, ID_NO, ID_STATIC, ID_FORWARD, ID_BACKWARD, ID_DEFAULT, ID_MORE, ID_SETUP, ID_RESET,
 ID_CONTEXT_HELP, ID_YESTOALL, ID_NOTOALL, ID_ABORT, ID_RETRY, ID_IGNORE, ID_ADD, ID_REMOVE, ID_UP, ID_DOWN, ID_HOME, ID_REFRESH,
 ID_STOP, ID_INDEX) = range(5100, 5126)
ID_EDIT, ID_FILE, ID_PREFERENCES, ID_INFO, ID_EXECUTE = 5150, 5151, 5152, 5153, 5154
ID_HIGHEST = 5999
_next_id = [10000]


def NewId():
    _next_id[0] += 1
    return _next_id[0]


class _IdRef(int):
    def GetId(self):
        return int(self)

    GetValue = GetId


NewIdRef = lambda count=1: _IdRef(NewId())
Window_NewControlId = NewId

HORIZONTAL, VERTICAL = 0x0004, 0x0008
BOTH = HORIZONTAL | VERTICAL
LEFT, RIGHT, UP, DOWN = 0x0010, 0x0020, 0x0040, 0x0080
TOP, BOTTOM, NORTH, SOUTH, WEST, EAST = UP, DOWN, UP, DOWN, LEFT, RIGHT
ALL = LEFT | RIGHT | UP | DOWN
ALIGN_NOT, ALIGN_LEFT, ALIGN_TOP = 0, 0, 0
ALIGN_CENTER_HORIZONTAL, ALIGN_RIGHT, ALIGN_BOTTOM, ALIGN_CENTER_VERTICAL = 0x0100, 0x0200, 0x0400, 0x0800
ALIGN_CENTRE_HORIZONTAL, ALIGN_CENTRE_VERTICAL = ALIGN_CENTER_HORIZONTAL, ALIGN_CENTER_VERTICAL
ALIGN_CENTER = ALIGN_CENTRE = ALIGN_CENTER_HORIZONTAL | ALIGN_CENTER_VERTICAL
ALIGN_MASK = 0x0f00
STRETCH_NOT, SHRINK, GROW, EXPAND, SHAPED, FIXED_MINSIZE, TILE = 0, 0x1000, 0x2000, 0x2000, 0x4000, 0x8000, 0xc000
RESERVE_SPACE_EVEN_IF_HIDDEN = 0x0002
CENTRE = CENTER = 0x0001
CENTER_ON_SCREEN = CENTRE_ON_SCREEN = 0x0002
OK, YES, NO, CANCEL, APPLY, CLOSE, HELP = 0x0004, 0x0002, 0x0008, 0x0010, 0x0020, 0x0040, 0x1000
YES_NO = YES | NO
OK_DEFAULT, YES_DEFAULT, NO_DEFAULT, CANCEL_DEFAULT = 0, 0, 0x0080, 0x80000000
ICON_EXCLAMATION = ICON_WARNING = 0x0100
ICON_HAND = ICON_ERROR = ICON_STOP = 0x0200
ICON_QUESTION, ICON_INFORMATION, ICON_NONE, ICON_ASTERISK, ICON_AUTH_NEEDED = 0x0400, 0x0800, 0x00040000, 0x0800, 0x00080000
STAY_ON_TOP, ICONIZE, MINIMIZE, MAXIMIZE, CLOSE_BOX, SYSTEM_MENU, MINIMIZE_BOX, MAXIMIZE_BOX = 0x8000, 0x4000, 0x4000, 0x2000, 0x1000, 0x0800, 0x0400, 0x0200
RESIZE_BORDER, CAPTION, TINY_CAPTION, CLIP_CHILDREN, TAB_TRAVERSAL, WANTS_CHARS = 0x0040, 0x20000000, 0x0080, 0x00400000, 0x00080000, 0x00040000
DEFAULT_DIALOG_STYLE = CAPTION | SYSTEM_MENU | CLOSE_BOX
DEFAULT_FRAME_STYLE = SYSTEM_MENU | RESIZE_BORDER | MINIMIZE_BOX | MAXIMIZE_BOX | CLOSE_BOX | CAPTION | CLIP_CHILDREN
FRAME_TOOL_WINDOW, FRAME_FLOAT_ON_PARENT, FRAME_NO_TASKBAR, FRAME_SHAPED, DIALOG_NO_PARENT = 0x0004, 0x0008, 0x0002, 0x0010, 0x0020
BORDER_DEFAULT, BORDER_NONE, BORDER_STATIC, BORDER_SIMPLE, BORDER_RAISED, BORDER_SUNKEN, BORDER_THEME = 0, 0x00200000, 0x01000000, 0x02000000, 0x04000000, 0x08000000, 0x10000000
NO_BORDER, SIMPLE_BORDER, SUNKEN_BORDER, RAISED_BORDER, STATIC_BORDER = BORDER_NONE, BORDER_SIMPLE, BORDER_SUNKEN, BORDER_RAISED, BORDER_STATIC
VSCROLL, HSCROLL, ALWAYS_SHOW_SB, FULL_REPAINT_ON_RESIZE, NO_FULL_REPAINT_ON_RESIZE = 0x80000000, 0x40000000, 0x00800000, 0x00010000, 0
TextEntryDialogStyle = 0x20000000 | 0x0004 | 0x0010 | 0x0001          # CAPTION | OK | CANCEL | CENTRE
TE_MULTILINE, TE_READONLY, TE_PASSWORD, TE_PROCESS_ENTER, TE_PROCESS_TAB, TE_RICH, TE_RICH2, TE_NO_VSCROLL, TE_AUTO_URL = 0x0020, 0x0010, 0x0800, 0x0400, 0x0040, 0x0080, 0x8000, 0x0002, 0x1000
TE_LEFT, TE_CENTER, TE_CENTRE, TE_RIGHT, TE_DONTWRAP, TE_WORDWRAP, TE_BESTWRAP, TE_CHARWRAP = 0, 0x0100, 0x0100, 0x0200, HSCROLL, 0x0001, 0, 0x4000
ST_NO_AUTORESIZE, ST_ELLIPSIZE_START, ST_ELLIPSIZE_MIDDLE, ST_ELLIPSIZE_END = 0x0001, 0x0004, 0x0008, 0x0010
CB_SIMPLE, CB_SORT, CB_READONLY, CB_DROPDOWN = 0x0004, 0x0008, 0x0010, 0x0020
LB_SORT, LB_SINGLE, LB_MULTIPLE, LB_EXTENDED, LB_NEEDED_SB, LB_ALWAYS_SB, LB_HSCROLL = 0x0010, 0x0020, 0x0040, 0x0080, 0x0200, 0x0400, HSCROLL
RB_GROUP, RB_SINGLE, RA_SPECIFY_COLS, RA_SPECIFY_ROWS, RA_HORIZONTAL, RA_VERTICAL = 0x0004, 0x0008, HORIZONTAL, VERTICAL, HORIZONTAL, VERTICAL
CHK_2STATE, CHK_3STATE, CHK_ALLOW_3RD_STATE_FOR_USER, CHK_UNCHECKED, CHK_CHECKED, CHK_UNDETERMINED = 0, 0x1000, 0x2000, 0, 1, 2
SL_HORIZONTAL, SL_VERTICAL, SL_LABELS, SL_AUTOTICKS, SL_MIN_MAX_LABELS, SL_VALUE_LABEL, SL_BOTH = HORIZONTAL, VERTICAL, 0x0020, 0x0010, 0x2000, 0x4000, 0x0100
GA_HORIZONTAL, GA_VERTICAL, GA_SMOOTH, GA_PROGRESS = HORIZONTAL, VERTICAL, 0x0020, 0x0010
SP_ARROW_KEYS, SP_WRAP, SP_HORIZONTAL, SP_VERTICAL = 0x4000, 0x8000, HORIZONTAL, VERTICAL
LI_HORIZONTAL, LI_VERTICAL = HORIZONTAL, VERTICAL
BU_LEFT, BU_TOP, BU_RIGHT, BU_BOTTOM, BU_EXACTFIT, BU_AUTODRAW, BU_NOTEXT = 0x0040, 0x0080, 0x0100, 0x0200, 0x0001, 0x0004, 0x0002
LC_ICON, LC_SMALL_ICON, LC_LIST, LC_REPORT, LC_SINGLE_SEL, LC_HRULES, LC_VRULES, LC_NO_HEADER, LC_EDIT_LABELS, LC_SORT_ASCENDING, LC_VIRTUAL = 0x0004, 0x0008, 0x0010, 0x0020, 0x2000, 0x8000, 0x0001, 0x0800, 0x0200, 0x4000, 0x0200
LIST_FORMAT_LEFT, LIST_FORMAT_RIGHT, LIST_FORMAT_CENTRE, LIST_FORMAT_CENTER = 0, 1, 2, 2
LIST_AUTOSIZE, LIST_AUTOSIZE_USEHEADER, LIST_NEXT_ALL, LIST_STATE_SELECTED, LIST_STATE_FOCUSED = -1, -2, 1, 0x0004, 0x0002
NB_TOP, NB_LEFT, NB_RIGHT, NB_BOTTOM, NB_FIXEDWIDTH, NB_MULTILINE = 0, 0x0020, 0x0040, 0x0080, 0x0100, 0x0800
FD_OPEN, FD_SAVE, FD_OVERWRITE_PROMPT, FD_FILE_MUST_EXIST, FD_MULTIPLE, FD_CHANGE_DIR, FD_PREVIEW = 0x0001, 0x0002, 0x0004, 0x0010, 0x0020, 0x0080, 0x0100
FD_DEFAULT_STYLE = FD_OPEN
DD_DEFAULT_STYLE, DD_DIR_MUST_EXIST, DD_NEW_DIR_BUTTON, DD_CHANGE_DIR = 0, 0x0200, 0, 0x0100
FLP_FILE_MUST_EXIST, FLP_OVERWRITE_PROMPT, FLP_CHANGE_DIR, FLP_SMALL, DIRP_DIR_MUST_EXIST, DIRP_CHANGE_DIR, DIRP_SMALL = 0x2000, 0x0100, 0x4000, 0x8000, 0x0008, 0x0010, 0x8000
HL_CONTEXTMENU, HL_ALIGN_LEFT, HL_ALIGN_RIGHT, HL_ALIGN_CENTRE, HL_DEFAULT_STYLE = 0x0001, 0x0002, 0x0004, 0x0008, 0x0009
CP_DEFAULT_STYLE, CP_NO_TLW_RESIZE = 0x0001, 0x0002
FLP_OPEN, FLP_SAVE, FLP_USE_TEXTCTRL, FLP_DEFAULT_STYLE, DIRP_DEFAULT_STYLE, DIRP_USE_TEXTCTRL = 0x0400, 0x0800, 0x0002, 0x2402, 0x000a, 0x0002
PD_APP_MODAL, PD_AUTO_HIDE, PD_CAN_ABORT, PD_ELAPSED_TIME, PD_ESTIMATED_TIME, PD_REMAINING_TIME, PD_SMOOTH, PD_CAN_SKIP = 0x0001, 0x0004, 0x0002, 0x0008, 0x0010, 0x0040, 0x0020, 0x0080
TEXT_ALIGNMENT_LEFT = 1
BITMAP_TYPE_ANY, BITMAP_TYPE_BMP, BITMAP_TYPE_ICO, BITMAP_TYPE_PNG, BITMAP_TYPE_JPEG, BITMAP_TYPE_XPM, BITMAP_TYPE_GIF = 50, 1, 3, 15, 17, 9, 13
FONTFAMILY_DEFAULT, FONTFAMILY_DECORATIVE, FONTFAMILY_ROMAN, FONTFAMILY_SCRIPT, FONTFAMILY_SWISS, FONTFAMILY_MODERN, FONTFAMILY_TELETYPE = 70, 71, 72, 73, 74, 75, 76
FONTSTYLE_NORMAL, FONTSTYLE_ITALIC, FONTSTYLE_SLANT, FONTWEIGHT_NORMAL, FONTWEIGHT_LIGHT, FONTWEIGHT_BOLD = 90, 93, 94, 400, 300, 700
FONTWEIGHT_THIN, FONTWEIGHT_EXTRALIGHT, FONTWEIGHT_MEDIUM, FONTWEIGHT_SEMIBOLD, FONTWEIGHT_EXTRABOLD, FONTWEIGHT_HEAVY, FONTWEIGHT_EXTRAHEAVY, FONTWEIGHT_MAX = 100, 200, 500, 600, 800, 900, 1000, 1000
DEFAULT, DECORATIVE, ROMAN, SCRIPT, SWISS, MODERN, TELETYPE, NORMAL, ITALIC, SLANT, LIGHT, BOLD = 70, 71, 72, 73, 74, 75, 76, 90, 93, 94, 300, 700
(SYS_COLOUR_WINDOW, SYS_COLOUR_WINDOWTEXT, SYS_COLOUR_BTNFACE, SYS_COLOUR_BTNTEXT, SYS_COLOUR_HIGHLIGHT, SYS_COLOUR_HIGHLIGHTTEXT,
 SYS_COLOUR_GRAYTEXT, SYS_COLOUR_BACKGROUND, SYS_COLOUR_3DFACE, SYS_COLOUR_MENU, SYS_COLOUR_INFOBK, SYS_COLOUR_INFOTEXT, SYS_COLOUR_LISTBOX,
 SYS_COLOUR_FRAMEBK, SYS_COLOUR_ACTIVECAPTION, SYS_COLOUR_INACTIVECAPTION, SYS_COLOUR_CAPTIONTEXT, SYS_COLOUR_3DLIGHT, SYS_COLOUR_WINDOWFRAME,
 SYS_COLOUR_BTNHIGHLIGHT, SYS_COLOUR_BTNSHADOW, SYS_COLOUR_HOTLIGHT, SYS_COLOUR_APPWORKSPACE, SYS_COLOUR_MENUTEXT, SYS_COLOUR_LISTBOXTEXT) = range(25)
SYS_DEFAULT_GUI_FONT, SYS_ANSI_FIXED_FONT, SYS_SYSTEM_FONT, SYS_OEM_FIXED_FONT = 17, 11, 13, 10
SYS_SCREEN_X, SYS_SCREEN_Y, SYS_VSCROLL_X, SYS_HSCROLL_Y = 1, 2, 28, 29
NOT_FOUND = -1
WXK_RETURN, WXK_ESCAPE, WXK_TAB, WXK_DELETE, WXK_BACK, WXK_SPACE, WXK_NUMPAD_ENTER, WXK_UP, WXK_DOWN, WXK_LEFT, WXK_RIGHT, WXK_F1 = 13, 27, 9, 127, 8, 32, 370, 315, 317, 314, 316, 340
MOD_NONE, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_CMD, MOD_WIN = 0, 1, 2, 4, 2, 8
ACCEL_NORMAL, ACCEL_ALT, ACCEL_CTRL, ACCEL_SHIFT = 0, 1, 2, 4
LANGUAGE_DEFAULT, LANGUAGE_ENGLISH = 0, 58
ALPHA_OPAQUE, ALPHA_TRANSPARENT = 255, 0
ButtonNameStr, PanelNameStr, StaticTextNameStr, ControlNameStr, FrameNameStr, DialogNameStr = "button", "panel", "staticText", "control", "frame", "dialog"
SYS_COLOUR_MENUBAR, SYS_COLOUR_MENUHILIGHT, SYS_COLOUR_GRADIENTACTIVECAPTION, SYS_COLOUR_GRADIENTINACTIVECAPTION = 25, 26, 27, 28
LANGUAGE_UNKNOWN, LANGUAGE_ENGLISH_US, LANGUAGE_ENGLISH_UK = 1, 79, 78
LANGUAGE_CHINESE, LANGUAGE_CHINESE_SIMPLIFIED, LANGUAGE_CHINESE_TRADITIONAL = 43, 44, 45
LANGUAGE_JAPANESE, LANGUAGE_JAPANESE_JAPAN, LANGUAGE_KOREAN, LANGUAGE_GERMAN, LANGUAGE_FRENCH, LANGUAGE_SPANISH = 120, 121, 127, 88, 79, 179
LANGUAGE_ITALIAN, LANGUAGE_RUSSIAN, LANGUAGE_PORTUGUESE, LANGUAGE_POLISH, LANGUAGE_DUTCH = 117, 160, 155, 154, 55
SHOW_EFFECT_NONE, SHOW_EFFECT_ROLL_TO_LEFT, SHOW_EFFECT_ROLL_TO_RIGHT, SHOW_EFFECT_ROLL_TO_TOP, SHOW_EFFECT_ROLL_TO_BOTTOM = 0, 1, 2, 3, 4
SHOW_EFFECT_SLIDE_TO_LEFT, SHOW_EFFECT_SLIDE_TO_RIGHT, SHOW_EFFECT_SLIDE_TO_TOP, SHOW_EFFECT_SLIDE_TO_BOTTOM, SHOW_EFFECT_BLEND, SHOW_EFFECT_EXPAND = 5, 6, 7, 8, 9, 10
ITEM_NORMAL, ITEM_CHECK, ITEM_RADIO, ITEM_SEPARATOR = 0, 1, 2, -1
ID_SEPARATOR = -2
WS_EX_VALIDATE_RECURSIVELY, WS_EX_BLOCK_EVENTS = 1, 2
TR_DEFAULT_STYLE, TR_HIDE_ROOT, TR_HAS_BUTTONS, TR_MULTIPLE = 0, 0x0800, 0x0001, 0x0020
TRANSPARENT, SOLID, PENSTYLE_SOLID, BRUSHSTYLE_SOLID, TRANSPARENT_WINDOW = 106, 100, 100, 100, 0x00100000
EmptyString = ""
DefaultCoord = -1
PlatformInfo = ("__WXWEB__", "wxWeb", "unicode", "wx-assertions-off", "phoenix")
Platform = "__WXWEB__"
VERSION = (4, 2, 2, 0, "")
VERSION_STRING = "4.2.2"
MAJOR_VERSION, MINOR_VERSION, RELEASE_NUMBER = 4, 2, 2
__version__ = "4.2.2"


def version():
    return "4.2.2 web"


class Point:
    def __init__(self, x=0, y=0):
        if isinstance(x, (tuple, list, Point)):
            x, y = x[0], x[1]
        self.x, self.y = x, y

    def __iter__(self):
        return iter((self.x, self.y))

    def __getitem__(self, i):
        return (self.x, self.y)[i]

    def __len__(self):
        return 2

    def Get(self):
        return (self.x, self.y)

    def __eq__(self, o):
        try:
            return self.x == o[0] and self.y == o[1]
        except Exception:
            return False

    def __add__(self, o):
        return type(self)(self.x + o[0], self.y + o[1])

    def __sub__(self, o):
        return type(self)(self.x - o[0], self.y - o[1])

    def __repr__(self):
        return f"wx.{type(self).__name__}({self.x}, {self.y})"


class Size(Point):
    width = property(lambda s: s.x, lambda s, v: setattr(s, "x", v))
    height = property(lambda s: s.y, lambda s, v: setattr(s, "y", v))

    def GetWidth(self):
        return self.x

    def GetHeight(self):
        return self.y

    def SetWidth(self, v):
        self.x = v

    def SetHeight(self, v):
        self.y = v

    def IsFullySpecified(self):
        return self.x >= 0 and self.y >= 0

    Width = property(lambda s: s.x, lambda s, v: setattr(s, "x", v))
    Height = property(lambda s: s.y, lambda s, v: setattr(s, "y", v))

    @staticmethod
    def _delta(a, k):
        if "dx" in k or "dy" in k:
            return k.get("dx", 0), k.get("dy", 0)
        if "pt" in k or "size" in k or "d" in k:
            a = (k.get("pt", k.get("size", k.get("d"))),)
        if len(a) == 1 and not isinstance(a[0], (int, float)):
            return a[0][0], a[0][1]
        return a[0], (a[1] if len(a) > 1 else a[0])

    def IncBy(self, *a, **k):
        dx, dy = self._delta(a, k)
        self.x += dx
        self.y += dy

    def DecBy(self, *a, **k):
        dx, dy = self._delta(a, k)
        self.x -= dx
        self.y -= dy

    def IncTo(self, sz):
        self.x, self.y = max(self.x, sz[0]), max(self.y, sz[1])

    def DecTo(self, sz):
        self.x, self.y = min(self.x, sz[0]), min(self.y, sz[1])

    def DecToIfSpecified(self, sz):
        if sz[0] != -1:
            self.x = min(self.x, sz[0])
        if sz[1] != -1:
            self.y = min(self.y, sz[1])

    def Scale(self, xs, ys):
        self.x, self.y = int(self.x * xs), int(self.y * ys)
        return self

    def SetDefaults(self, sz):
        if self.x == -1:
            self.x = sz[0]
        if self.y == -1:
            self.y = sz[1]

    def Set(self, w, h):
        self.x, self.y = w, h


RealPoint = Point
Point2D = Point


class Rect:
    """wx.Rect: Rect(), Rect(x, y, w, h), Rect(pos, size), Rect(topLeft, bottomRight), Rect(size)."""

    def __init__(self, *a, **k):
        x = y = width = height = 0
        if len(a) == 4:
            x, y, width, height = a
        elif len(a) == 2:
            p, q = a
            x, y = p[0], p[1]
            if isinstance(q, Point) and not isinstance(q, Size):
                width, height = q[0] - x + 1, q[1] - y + 1
            else:
                width, height = q[0], q[1]
        elif len(a) == 1:
            if isinstance(a[0], Rect):
                x, y, width, height = a[0].Get()
            else:
                width, height = a[0][0], a[0][1]
        self.x, self.y = k.get("x", x), k.get("y", y)
        self.width, self.height = k.get("width", width), k.get("height", height)

    def GetX(self):
        return self.x

    def GetY(self):
        return self.y

    def GetWidth(self):
        return self.width

    def GetHeight(self):
        return self.height

    def SetX(self, v):
        self.x = v

    def SetY(self, v):
        self.y = v

    def SetWidth(self, v):
        self.width = v

    def SetHeight(self, v):
        self.height = v

    def GetSize(self):
        return Size(self.width, self.height)

    def SetSize(self, s):
        self.width, self.height = s[0], s[1]

    def GetPosition(self):
        return Point(self.x, self.y)

    def SetPosition(self, p):
        self.x, self.y = p[0], p[1]

    def GetLeft(self):
        return self.x

    def GetTop(self):
        return self.y

    def GetRight(self):
        return self.x + self.width - 1

    def GetBottom(self):
        return self.y + self.height - 1

    def SetLeft(self, v):
        self.width += self.x - v
        self.x = v

    def SetTop(self, v):
        self.height += self.y - v
        self.y = v

    def SetRight(self, v):
        self.width = v - self.x + 1

    def SetBottom(self, v):
        self.height = v - self.y + 1

    left = Left = property(GetLeft, SetLeft)
    top = Top = property(GetTop, SetTop)
    right = Right = property(GetRight, SetRight)
    bottom = Bottom = property(GetBottom, SetBottom)
    X = property(GetX, SetX)
    Y = property(GetY, SetY)
    Width = property(GetWidth, SetWidth)
    Height = property(GetHeight, SetHeight)
    Size = property(GetSize, SetSize)
    Position = property(GetPosition, SetPosition)

    def GetTopLeft(self):
        return Point(self.x, self.y)

    def GetTopRight(self):
        return Point(self.GetRight(), self.y)

    def GetBottomLeft(self):
        return Point(self.x, self.GetBottom())

    def GetBottomRight(self):
        return Point(self.GetRight(), self.GetBottom())

    TopLeft = property(GetTopLeft)
    TopRight = property(GetTopRight)
    BottomLeft = property(GetBottomLeft)
    BottomRight = property(GetBottomRight)

    def GetCentre(self):
        return Point(self.x + self.width // 2, self.y + self.height // 2)

    GetCenter = GetCentre

    def Get(self):
        return (self.x, self.y, self.width, self.height)

    def IsEmpty(self):
        return self.width <= 0 or self.height <= 0

    def Contains(self, *a):
        if len(a) == 1 and isinstance(a[0], Rect):
            r = a[0]
            return self.Contains(r.x, r.y) and self.Contains(r.GetRight(), r.GetBottom())
        px, py = (a[0], a[1]) if len(a) >= 2 else (a[0][0], a[0][1])
        return self.x <= px < self.x + self.width and self.y <= py < self.y + self.height

    Inside = Contains

    def Intersects(self, r):
        return not (r.x >= self.x + self.width or r.x + r.width <= self.x or r.y >= self.y + self.height or r.y + r.height <= self.y)

    def Intersect(self, r):
        x0, y0 = max(self.x, r.x), max(self.y, r.y)
        x1, y1 = min(self.x + self.width, r.x + r.width), min(self.y + self.height, r.y + r.height)
        self.x, self.y, self.width, self.height = (x0, y0, x1 - x0, y1 - y0) if x1 > x0 and y1 > y0 else (0, 0, 0, 0)
        return self

    def Union(self, r):
        if r.IsEmpty():
            return self
        if self.IsEmpty():
            self.x, self.y, self.width, self.height = r.Get()
            return self
        x0, y0 = min(self.x, r.x), min(self.y, r.y)
        x1, y1 = max(self.x + self.width, r.x + r.width), max(self.y + self.height, r.y + r.height)
        self.x, self.y, self.width, self.height = x0, y0, x1 - x0, y1 - y0
        return self

    def Inflate(self, dx, dy=None):
        dy = dx if dy is None else dy
        self.x -= dx
        self.y -= dy
        self.width += 2 * dx
        self.height += 2 * dy
        return self

    def Deflate(self, dx, dy=None):
        return self.Inflate(-dx, -(dx if dy is None else dy))

    def Offset(self, *a):
        dx, dy = (a[0], a[1]) if len(a) >= 2 else (a[0][0], a[0][1])
        self.x += dx
        self.y += dy

    def CentreIn(self, r, dir=0x0004 | 0x0008):
        return Rect(r.x + (r.width - self.width) // 2 if dir & 0x0004 else self.x,
                    r.y + (r.height - self.height) // 2 if dir & 0x0008 else self.y, self.width, self.height)

    CenterIn = CentreIn

    def __iter__(self):
        return iter(self.Get())

    def __getitem__(self, i):
        return self.Get()[i]

    def __len__(self):
        return 4

    def __eq__(self, o):
        try:
            return tuple(self.Get()) == tuple(o)
        except TypeError:
            return False

    def __ne__(self, o):
        return not self.__eq__(o)

    def __hash__(self):
        return hash(self.Get())

    def __repr__(self):
        return f"wx.Rect({self.x}, {self.y}, {self.width}, {self.height})"


DefaultPosition = Point(-1, -1)
DefaultSize = Size(-1, -1)


class Colour:
    def __init__(self, r=0, g=0, b=0, a=255):
        if isinstance(r, Colour):
            r, g, b, a = r.r, r.g, r.b, r.a
        elif isinstance(r, str):
            s = r.lstrip("#")
            named = {"red": "ff0000", "green": "008000", "blue": "0000ff", "black": "000000", "white": "ffffff", "yellow": "ffff00",
                     "grey": "808080", "gray": "808080", "orange": "ffa500", "light grey": "d3d3d3", "cyan": "00ffff", "magenta": "ff00ff"}
            s = named.get(s.lower(), s)
            try:
                r, g, b = int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
            except ValueError:
                r = g = b = 0
        elif isinstance(r, (tuple, list)):
            a = r[3] if len(r) > 3 else 255
            r, g, b = r[0], r[1], r[2]
        self.r, self.g, self.b, self.a = int(r), int(g), int(b), int(a)

    def Red(self):
        return self.r

    def Green(self):
        return self.g

    def Blue(self):
        return self.b

    def Alpha(self):
        return self.a

    def Get(self, includeAlpha=True):
        return (self.r, self.g, self.b, self.a) if includeAlpha else (self.r, self.g, self.b)

    def GetAsString(self, *_):
        return "#%02x%02x%02x" % (self.r, self.g, self.b)

    def GetRGB(self):
        return self.r | (self.g << 8) | (self.b << 16)

    def IsOk(self):
        return True

    def GetLuminance(self):
        return (0.299 * self.r + 0.587 * self.g + 0.114 * self.b) / 255.0

    def Set(self, *a):
        """Set(r, g, b, a=255), Set("#rrggbb") or Set(0xBBGGRR)."""
        if len(a) == 1 and isinstance(a[0], int):
            v = a[0]
            self.r, self.g, self.b, self.a = v & 255, (v >> 8) & 255, (v >> 16) & 255, 255
        else:
            c = Colour(*a)
            self.r, self.g, self.b, self.a = c.r, c.g, c.b, c.a
        return True

    SetRGB = Set

    def SetRGBA(self, v):
        self.r, self.g, self.b, self.a = v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255

    def GetRGBA(self):
        return self.r | (self.g << 8) | (self.b << 16) | (self.a << 24)

    red = property(lambda self: self.r)
    green = property(lambda self: self.g)
    blue = property(lambda self: self.b)
    alpha = property(lambda self: self.a)

    def MakeDisabled(self, brightness=255):
        f = lambda v: int((v + brightness) / 2)
        return Colour(f(self.r), f(self.g), f(self.b), self.a)

    def ChangeLightness(self, *_):
        return Colour(self)

    def _css(self):
        return f"rgba({self.r},{self.g},{self.b},{self.a / 255.0:.3f})"

    def __iter__(self):
        return iter((self.r, self.g, self.b, self.a))

    def __getitem__(self, i):
        return (self.r, self.g, self.b, self.a)[i]

    def __eq__(self, o):
        return isinstance(o, Colour) and tuple(o) == tuple(self)

    def __hash__(self):
        return hash(tuple(self))


Color = Colour
NamedColour = Colour
BLACK, WHITE, RED, GREEN, BLUE, YELLOW, LIGHT_GREY, CYAN = (Colour(0, 0, 0), Colour(255, 255, 255), Colour(255, 0, 0), Colour(0, 128, 0),
                                                              Colour(0, 0, 255), Colour(255, 255, 0), Colour(211, 211, 211), Colour(0, 255, 255))
NullColour = Colour(0, 0, 0, 0)
TransparentColour = Colour(0, 0, 0, 0)


# ---- fonts a plugin brings with it (wx.Font.AddPrivateFont; on the desktop the person installs them)

_private_fonts = {}        # family name, lower case -> the file it was loaded from
_font_files = None         # family name, lower case -> font files in the plugin's own folder


def _font_names(path):
    """(family names, is a variable font) read from a TrueType / OpenType file's own tables."""
    import struct
    try:
        with open(path, "rb") as fh:
            data = fh.read()
        count = struct.unpack(">H", data[4:6])[0]
        tables = {data[12 + i * 16:16 + i * 16]: struct.unpack(">II", data[20 + i * 16:28 + i * 16]) for i in range(count)}
        at = tables[b"name"][0]
        n, strings = struct.unpack(">HH", data[at + 2:at + 6])
        names = []
        for i in range(n):
            platform, _enc, _lang, name_id, length, offset = struct.unpack(">HHHHHH", data[at + 6 + i * 12:at + 18 + i * 12])
            if name_id not in (1, 16):
                continue
            raw = data[at + strings + offset:at + strings + offset + length]
            text = raw.decode("utf-16-be" if platform in (0, 3) else "latin-1", "replace").strip()
            if text and text not in names:
                names.append(text)
        return names, b"fvar" in tables
    except Exception:
        return [], False


def _add_private_font(path):
    """Make a font file's family usable by name in this frame.  True when it is (or already was)."""
    path = str(path)
    names, variable = _font_names(path)
    if not names:
        return False
    fresh = [n for n in names if n.lower() not in _private_fonts]
    if not fresh:
        return True
    if _DOM:
        try:
            from pyodide.ffi import to_js
            with open(path, "rb") as fh:
                data = to_js(fh.read())
            for n in fresh:
                face = _js.FontFace.new(n, data.buffer, _js.Object.fromEntries(to_js([["weight", "100 900"]])) if variable else _js.Object.new())
                _wait(face.load())
                _js.document.fonts.add(face)
        except Exception as e:
            import logging
            logging.getLogger("kicad_web").warning("The font %s could not be loaded: %s", path.rsplit("/", 1)[-1], str(e).splitlines()[-1] if str(e) else e)
            return False
        from . import _paint
        _paint._measured.clear()
    for n in fresh:
        _private_fonts[n.lower()] = path
    return True


def _ensure_face(name):
    """A face a plugin asks for by name that is among the font files in its own folder is loaded from there."""
    global _font_files
    key = str(name or "").strip().lower()
    if not key or key in _private_fonts:
        return
    if _font_files is None:
        _font_files = {}
        try:
            import os
            import kicad_web
            root = kicad_web.PLUGIN_DIR + "/" + kicad_web._plugin.get("package", "")
            for folder, _dirs, files in os.walk(root):
                for f in files:
                    if f.lower().endswith((".ttf", ".otf")):
                        for n in _font_names(os.path.join(folder, f))[0]:
                            _font_files.setdefault(n.lower(), os.path.join(folder, f))
        except Exception:
            pass
    path = _font_files.get(key)
    if path:
        _add_private_font(path)
    else:
        _private_fonts.setdefault(key, "")       # not one of the plugin's: the browser's own fonts answer


class Font:
    AddPrivateFont = staticmethod(_add_private_font)
    CanUsePrivateFont = staticmethod(lambda: True)

    def __init__(self, pointSize=10, family=FONTFAMILY_DEFAULT, style=FONTSTYLE_NORMAL, weight=FONTWEIGHT_NORMAL, underline=False, faceName="", *_, **kw):
        if isinstance(pointSize, Font):
            f = pointSize
            pointSize, family, style, weight, underline, faceName = f._size, f._family, f._wx_style, f._weight, f._underline, f._face
            self._strike = f.__dict__.get("_strike", False)
        elif isinstance(getattr(pointSize, "_f", None), Font):          # wx.Font(wx.FontInfo(10).Family(…))
            f = pointSize._f
            pointSize, family, style, weight, underline, faceName = f._size, f._family, f._wx_style, f._weight, f._underline, f._face
            self._strike = f.__dict__.get("_strike", False)
        elif not isinstance(pointSize, (int, float)):
            pointSize = 10
        self._size, self._family, self._wx_style, self._weight, self._underline, self._face = pointSize, family, style, weight, underline, kw.get("faceName", faceName)
        if self._face:
            _ensure_face(self._face)

    def GetPointSize(self):
        return self._size

    def SetPointSize(self, v):
        self._size = v

    def GetFractionalPointSize(self):
        return float(self._size)

    def SetWeight(self, w):
        self._weight = w

    def GetWeight(self):
        return self._weight

    def SetStyle(self, s):
        self._wx_style = s

    def SetFamily(self, f):
        self._family = f

    def SetUnderlined(self, u):
        self._underline = bool(u)

    def SetStrikethrough(self, on):
        self._strike = bool(on)

    GetStrikethrough = lambda self: bool(self.__dict__.get("_strike", False))

    def Strikethrough(self):
        f = Font(self)
        f._strike = True
        return f

    MakeStrikethrough = lambda self: (setattr(self, "_strike", True), self)[1]
    GetUnderlined = lambda self: bool(self._underline)

    def Underlined(self):
        f = Font(self)
        f._underline = True
        return f

    MakeUnderlined = lambda self: (setattr(self, "_underline", True), self)[1]

    def SetFaceName(self, n):
        self._face = n
        _ensure_face(n)
        return True

    def GetFaceName(self):
        return self._face

    def Bold(self):
        f = Font(self)
        f._weight = FONTWEIGHT_BOLD
        return f

    MakeBold = lambda self: (setattr(self, "_weight", FONTWEIGHT_BOLD), self)[1]

    def Italic(self):
        f = Font(self)
        f._wx_style = FONTSTYLE_ITALIC
        return f

    MakeItalic = lambda self: (setattr(self, "_wx_style", FONTSTYLE_ITALIC), self)[1]

    def Larger(self):
        f = Font(self)
        f._size = self._size * 1.2
        return f

    def Smaller(self):
        f = Font(self)
        f._size = self._size / 1.2
        return f

    def Scale(self, k):
        self._size = self._size * k
        return self

    Scaled = lambda self, k: Font(self).Scale(k)
    MakeLarger = lambda self: self.Scale(1.2)
    MakeSmaller = lambda self: self.Scale(1 / 1.2)

    def IsOk(self):
        return True

    def GetPixelSize(self):
        return Size(0, int(self._size * 1.33))

    def _apply(self, el):
        if _private_fonts.get(str(self._face or "").lower()):       # a font the plugin brought: by name, at the weight asked for
            el.style.fontFamily = '"%s", system-ui, sans-serif' % str(self._face).replace('"', "")
            if isinstance(self._weight, (int, float)) and 100 <= self._weight <= 1000:
                el.style.fontWeight = str(int(self._weight))
        elif self._weight >= FONTWEIGHT_BOLD:
            el.style.fontWeight = "600"
        if self._wx_style in (FONTSTYLE_ITALIC, FONTSTYLE_SLANT):
            el.style.fontStyle = "italic"
        if self._family in (FONTFAMILY_MODERN, FONTFAMILY_TELETYPE):
            el.style.fontFamily = "var(--mono)"
        if self._size and abs(self._size - 10) >= 1:
            el.style.fontSize = f"{max(8, min(28, self._size * 1.2)):.0f}px"
        lines = " ".join(w for w, on in (("underline", self._underline), ("line-through", self.__dict__.get("_strike"))) if on)
        if lines:
            el.style.textDecoration = lines
        elif el.style.textDecoration:
            el.style.textDecoration = ""          # a font without lines takes them off again (a task unticked)


NORMAL_FONT = Font(10)
SMALL_FONT = Font(8)
ITALIC_FONT = Font(10, style=FONTSTYLE_ITALIC)
SWISS_FONT = Font(10, FONTFAMILY_SWISS)


class FontInfo:
    def __init__(self, size=10):
        self._f = Font(size)

    def Bold(self, on=True):
        self._f._weight = FONTWEIGHT_BOLD if on else FONTWEIGHT_NORMAL
        return self

    def Italic(self, on=True):
        self._f._wx_style = FONTSTYLE_ITALIC if on else FONTSTYLE_NORMAL
        return self

    def Family(self, f):
        self._f._family = f
        return self

    def FaceName(self, n):
        self._f.SetFaceName(n)
        return self

    def Strikethrough(self, on=True):
        self._f._strike = bool(on)
        return self

    def Underlined(self, on=True):
        self._f._underline = on
        return self


class SystemSettings:
    @staticmethod
    def GetColour(index):
        dark = SystemSettings.GetAppearance().IsDark()
        fg, bg = (Colour(230, 230, 230), Colour(30, 30, 30)) if dark else (Colour(20, 20, 20), Colour(250, 250, 250))
        return fg if index in (SYS_COLOUR_WINDOWTEXT, SYS_COLOUR_BTNTEXT, SYS_COLOUR_MENUTEXT, SYS_COLOUR_CAPTIONTEXT, SYS_COLOUR_INFOTEXT, SYS_COLOUR_LISTBOXTEXT) else (
            Colour(128, 128, 128) if index == SYS_COLOUR_GRAYTEXT else (Colour(38, 110, 220) if index in (SYS_COLOUR_HIGHLIGHT, SYS_COLOUR_HOTLIGHT) else bg))

    @staticmethod
    def GetFont(index):
        return Font(10, FONTFAMILY_TELETYPE if index in (SYS_ANSI_FIXED_FONT, SYS_OEM_FIXED_FONT) else FONTFAMILY_DEFAULT)

    @staticmethod
    def GetMetric(index, *_):
        return {SYS_SCREEN_X: 1280, SYS_SCREEN_Y: 800}.get(index, 16)

    @staticmethod
    def GetAppearance():
        class _A:
            def IsDark(self):
                if _DOM:
                    return str(_js.document.documentElement.getAttribute("data-theme")) == "dark"
                return False

            IsUsingDarkBackground = IsDark

            def GetName(self):
                return ""
        return _A()


def _data_url(path):
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return ""
    ext = _os.path.splitext(str(path))[1].lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon"}.get(ext, "image/png")
    return f"data:{mime};base64," + _b64.b64encode(raw).decode("ascii")


# ----------------------------------------------------------------------------- images
# A bitmap here is real: its pixels (RGBA), or the file it was read from, or what was drawn on it through a
# MemoryDC.  Shown in a window it becomes a PNG; drawn on a canvas it is drawn there.

def _png_encode(w, h, rgba):
    import struct
    import zlib

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b"")


def _png_size(data):
    import struct
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    return None


def _png_decode(data):
    """(width, height, RGBA bytes) of a PNG, or None.  Pillow reads it where the plugin loaded Pillow; otherwise the
    plain 8-bit kinds are read here."""
    try:
        from PIL import Image as _PILImage
        import io
        im = _PILImage.open(io.BytesIO(bytes(data))).convert("RGBA")
        return im.width, im.height, bytearray(im.tobytes())
    except Exception:
        pass
    import struct
    import zlib
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos, idat, plte, trns, hdr = 8, [], None, None, None
    while pos + 8 <= len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b"IHDR":
            hdr = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"PLTE":
            plte = body
        elif kind == b"tRNS":
            trns = body
        elif kind == b"IEND":
            break
    if hdr is None or hdr[2] != 8 or hdr[6] != 0:
        return None
    w, h, _depth, ctype = hdr[0], hdr[1], hdr[2], hdr[3]
    bpp = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(ctype)
    if bpp is None:
        return None
    raw = zlib.decompress(b"".join(idat))
    stride = w * bpp
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                line[i] = (line[i] + (((line[i - bpp] if i >= bpp else 0) + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else (b if pb <= pc else c))) & 255
        prev = line
        row = memoryview(out)[y * w * 4:(y + 1) * w * 4]
        if ctype == 6:
            row[:] = line
        elif ctype == 2:
            row[0::4], row[1::4], row[2::4] = line[0::3], line[1::3], line[2::3]
            row[3::4] = b"\xff" * w
        elif ctype == 0:
            row[0::4] = row[1::4] = row[2::4] = line
            row[3::4] = b"\xff" * w
        elif ctype == 4:
            row[0::4] = row[1::4] = row[2::4] = line[0::2]
            row[3::4] = line[1::2]
        else:
            for x in range(w):
                k = line[x]
                row[x * 4:x * 4 + 3] = (plte or b"")[k * 3:k * 3 + 3].ljust(3, b"\0")
                row[x * 4 + 3] = trns[k] if trns is not None and k < len(trns) else 255
    return w, h, out


def _url_bytes(url):
    if isinstance(url, str) and url.startswith("data:") and ";base64," in url:
        try:
            return _b64.b64decode(url.split(";base64,", 1)[1])
        except Exception:
            return None
    return None


class Bitmap:
    def __init__(self, name=None, *a, **k):
        self._src = ""           # a data: address, for an image read from a file
        self._rgba = None        # or its pixels
        self._ops = None         # and what was drawn on it (MemoryDC)
        self._png = None
        self._blank = False
        self._w = self._h = 16
        if isinstance(name, str) and name:
            self._load(name)
        elif isinstance(name, Bitmap):
            self._take(name)
        elif isinstance(name, (Size, tuple, list)) and len(name) >= 2:
            self._w, self._h, self._blank = max(0, int(name[0])), max(0, int(name[1])), True
        elif isinstance(name, int) and not isinstance(name, bool) and a and isinstance(a[0], int):
            self._w, self._h, self._blank = max(0, name), max(0, a[0]), True
        elif isinstance(name, (bytes, bytearray, memoryview)):
            self._set_src("data:image/png;base64," + _b64.b64encode(bytes(name)).decode("ascii"))

    # -- what it holds
    def _take(self, other):
        self._src, self._w, self._h, self._blank, self._png = other._src, other._w, other._h, other._blank, other._png
        self._rgba = bytearray(other._rgba) if other._rgba is not None else None
        self._ops = list(other._ops) if other._ops else None

    def _set_src(self, url):
        self._src, self._rgba, self._ops, self._png, self._blank = url or "", None, None, None, False
        if self._src.startswith("data:image/png;base64,"):
            try:
                size = _png_size(_b64.b64decode(self._src[22:22 + 44]))
            except Exception:
                size = None
            if size:
                self._w, self._h = int(size[0]), int(size[1])

    def _load(self, path):
        self._set_src(_data_url(path))
        return bool(self._src)

    def _get_url(self):
        if self._ops:
            return _paint.raster(self)
        if self._rgba is not None:
            if self._png is None:
                self._png = "data:image/png;base64," + _b64.b64encode(_png_encode(self._w, self._h, self._rgba)).decode("ascii")
            return self._png
        return self._src

    _url = property(_get_url, _set_src)

    def _pixels(self):
        """The pixels, RGBA, to read and to change."""
        if self._rgba is None:
            got = None
            raw = _url_bytes(self._src)
            if raw is not None:
                got = _png_decode(raw)
            if got is not None:
                self._w, self._h, self._rgba = got
            else:
                self._rgba = bytearray(b"\0\0\0\xff" * (self._w * self._h))
            self._src = ""
        self._png = None
        return self._rgba

    def _set_rgb(self, rgb, alpha=None):
        n = self._w * self._h
        px = bytearray(b"\xff" * (n * 4))
        rgb = bytes(rgb)[:n * 3].ljust(n * 3, b"\0")
        px[0::4], px[1::4], px[2::4] = rgb[0::3], rgb[1::3], rgb[2::3]
        if alpha is not None:
            px[3::4] = bytes(alpha)[:n].ljust(n, b"\xff")
        self._rgba, self._src, self._ops, self._png, self._blank = px, "", None, None, False

    def IsOk(self):
        return bool(self._src) or self._rgba is not None or bool(self._ops) or self._blank

    Ok = IsOk

    def GetWidth(self):
        return self._w

    def GetHeight(self):
        return self._h

    def GetSize(self):
        return Size(self._w, self._h)

    GetLogicalSize = GetDIPSize = GetScaledSize = GetSize
    GetLogicalWidth = GetScaledWidth = GetWidth
    GetLogicalHeight = GetScaledHeight = GetHeight
    GetDepth = lambda self: 32
    HasAlpha = lambda self: True

    def ConvertToImage(self):
        return Image(self)

    def LoadFile(self, name, *_):
        return self._load(name)

    def SaveFile(self, name, *_):
        url = self._url
        raw = _url_bytes(url)
        if raw is None:
            return False
        try:
            with open(name, "wb") as fh:
                fh.write(raw)
        except OSError:
            return False
        return True

    def SetSize(self, *a):
        pass

    SetWidth = SetHeight = SetDepth = SetMask = SetScaleFactor = lambda self, *a: None

    def GetScaleFactor(self):
        return 1.0

    def Create(self, w, h=None, *_):
        if h is None:
            w, h = w[0], w[1]
        self._w, self._h, self._blank = int(w), int(h), True
        self._src, self._rgba, self._ops, self._png = "", None, None, None
        return True

    def GetSubBitmap(self, rect):
        x, y, w, h = (rect.x, rect.y, rect.width, rect.height) if isinstance(rect, Rect) else tuple(rect)[:4]
        return Bitmap(Image(self).GetSubImage(Rect(x, y, w, h)))

    @staticmethod
    def FromRGBA(w, h, red=0, green=0, blue=0, alpha=0):
        b = Bitmap(int(w), int(h))
        b._rgba = bytearray(bytes((red & 255, green & 255, blue & 255, alpha & 255)) * (b._w * b._h))
        return b

    @staticmethod
    def FromBufferRGBA(w, h, data):
        b = Bitmap(int(w), int(h))
        n = b._w * b._h * 4
        b._rgba = bytearray(bytes(data)[:n].ljust(n, b"\0"))
        return b

    @staticmethod
    def FromBuffer(w, h, data):
        b = Bitmap(int(w), int(h))
        b._set_rgb(data)
        return b

    @staticmethod
    def FromBufferAndAlpha(w, h, data, alpha):
        b = Bitmap(int(w), int(h))
        b._set_rgb(data, alpha)
        return b

    def CopyFromBuffer(self, data, format=None, stride=-1):
        n = self._w * self._h
        data = bytes(data)
        if len(data) >= n * 4:
            self._rgba, self._src, self._ops, self._png = bytearray(data[:n * 4]), "", None, None
        else:
            self._set_rgb(data)

    def CopyToBuffer(self, data, *_):
        px = self._pixels()
        try:
            data[:len(px)] = px
        except Exception:
            pass

    @staticmethod
    def NewFromPNGData(data, *_):
        return Bitmap(bytes(data))

    FromPNGData = NewFromPNGData

    def CopyFromIcon(self, icon):
        self._take(icon)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return _NULL


class Image(Bitmap):
    def __init__(self, name=None, *a, **k):
        clear = True
        if isinstance(name, int) and not isinstance(name, bool) and len(a) >= 2 and isinstance(a[1], (bytes, bytearray, memoryview)):
            Bitmap.__init__(self, name, a[0])          # Image(width, height, data[, alpha])
            self._set_rgb(a[1], a[2] if len(a) > 2 else None)
            return
        Bitmap.__init__(self, name, *a, **k)
        if self._blank and clear:
            self._rgba = bytearray(b"\0\0\0\xff" * (self._w * self._h))

    def Create(self, w, h=None, *_):
        Bitmap.Create(self, w, h)
        self._rgba = bytearray(b"\0\0\0\xff" * (self._w * self._h))
        return True

    def SetData(self, data, *size):
        if len(size) >= 2:
            self._w, self._h = int(size[0]), int(size[1])
        alpha = bytes(self._rgba[3::4]) if self._rgba is not None and len(self._rgba) == self._w * self._h * 4 else None
        self._set_rgb(data, alpha)

    SetDataBuffer = SetData

    def GetData(self):
        px = self._pixels()
        out = bytearray(self._w * self._h * 3)
        out[0::3], out[1::3], out[2::3] = px[0::4], px[1::4], px[2::4]
        return out

    GetDataBuffer = GetData

    def SetAlpha(self, *a):
        px = self._pixels()
        if len(a) == 3:                              # SetAlpha(x, y, alpha)
            x, y, v = int(a[0]), int(a[1]), int(a[2])
            if 0 <= x < self._w and 0 <= y < self._h:
                px[(y * self._w + x) * 4 + 3] = v & 255
        elif a:
            n = self._w * self._h
            px[3::4] = bytes(a[0])[:n].ljust(n, b"\xff")

    SetAlphaData = SetAlphaBuffer = SetAlpha

    def GetAlpha(self, *a):
        px = self._pixels()
        if len(a) == 2:
            return px[(int(a[1]) * self._w + int(a[0])) * 4 + 3]
        return bytearray(px[3::4])

    GetAlphaData = GetAlphaBuffer = GetAlpha

    def HasAlpha(self):
        return True

    def InitAlpha(self):
        self._pixels()

    ClearAlpha = lambda self: self.SetAlpha(b"\xff" * (self._w * self._h))

    def SetRGB(self, *a):
        px = self._pixels()
        if isinstance(a[0], Rect):
            rect, r, g, b = a[0], a[1], a[2], a[3]
            for y in range(max(0, rect.y), min(self._h, rect.y + rect.height)):
                for x in range(max(0, rect.x), min(self._w, rect.x + rect.width)):
                    px[(y * self._w + x) * 4:(y * self._w + x) * 4 + 3] = bytes((r & 255, g & 255, b & 255))
            return
        x, y, r, g, b = int(a[0]), int(a[1]), a[2], a[3], a[4]
        if 0 <= x < self._w and 0 <= y < self._h:
            px[(y * self._w + x) * 4:(y * self._w + x) * 4 + 3] = bytes((r & 255, g & 255, b & 255))

    def _at(self, x, y, k):
        px = self._pixels()
        return px[(int(y) * self._w + int(x)) * 4 + k] if 0 <= x < self._w and 0 <= y < self._h else 0

    GetRed = lambda self, x, y: self._at(x, y, 0)
    GetGreen = lambda self, x, y: self._at(x, y, 1)
    GetBlue = lambda self, x, y: self._at(x, y, 2)

    def Copy(self):
        return Image(self)

    def Clear(self, value=0):
        self._rgba = bytearray(bytes((value & 255, value & 255, value & 255, 255)) * (self._w * self._h))
        self._png = None

    def Scale(self, w, h, *_):
        w, h = max(1, int(w)), max(1, int(h))
        i = Image(self)
        if self._rgba is None and not (self._src.startswith("data:image/png") and not self._ops):
            i._w, i._h = w, h                           # a file the browser scales when it shows it
            return i
        px, sw, sh = self._pixels(), self._w, self._h
        i._src, i._ops, i._png = "", None, None
        if sw == 0 or sh == 0:
            i._w, i._h, i._rgba = w, h, bytearray(b"\0\0\0\xff" * (w * h))
            return i
        cols = [min(sw - 1, x * sw // w) * 4 for x in range(w)]
        out = bytearray()
        last_y, last_row = -1, b""
        for y in range(h):
            sy = min(sh - 1, y * sh // h)
            if sy != last_y:
                row = px[sy * sw * 4:(sy + 1) * sw * 4]
                last_row = b"".join([row[c:c + 4] for c in cols]) if w != sw else bytes(row)
                last_y = sy
            out += last_row
        i._w, i._h, i._rgba = w, h, out
        return i

    def Rescale(self, w, h, *_):
        self._take(self.Scale(w, h))
        return self

    ResampleNearest = ResampleBilinear = ResampleBicubic = ResampleBox = Scale

    def GetSubImage(self, rect):
        px = self._pixels()
        x0, y0 = max(0, int(rect.x)), max(0, int(rect.y))
        w, h = max(0, min(self._w - x0, int(rect.width))), max(0, min(self._h - y0, int(rect.height)))
        i = Image(w, h)
        out = bytearray()
        for y in range(y0, y0 + h):
            out += px[(y * self._w + x0) * 4:(y * self._w + x0 + w) * 4]
        i._rgba = out
        return i

    def Mirror(self, horizontally=True):
        px, w, h = self._pixels(), self._w, self._h
        i = Image(w, h)
        out = bytearray()
        rows = [px[y * w * 4:(y + 1) * w * 4] for y in range(h)]
        if horizontally:
            for row in rows:
                out += b"".join([row[x * 4:x * 4 + 4] for x in range(w - 1, -1, -1)])
        else:
            for row in reversed(rows):
                out += row
        i._rgba = out
        return i

    def Rotate90(self, clockwise=True):
        px, w, h = self._pixels(), self._w, self._h
        i = Image(h, w)
        out = bytearray(w * h * 4)
        for y in range(h):
            for x in range(w):
                nx, ny = (h - 1 - y, x) if clockwise else (y, w - 1 - x)
                out[(ny * h + nx) * 4:(ny * h + nx) * 4 + 4] = px[(y * w + x) * 4:(y * w + x) * 4 + 4]
        i._rgba = out
        return i

    def ConvertToGreyscale(self, *_):
        px = self._pixels()
        i = Image(self._w, self._h)
        r, g, b = px[0::4], px[1::4], px[2::4]
        grey = bytes((299 * r[k] + 587 * g[k] + 114 * b[k]) // 1000 for k in range(self._w * self._h))
        out = bytearray(px)
        out[0::4] = out[1::4] = out[2::4] = grey
        i._rgba = out
        return i

    ConvertToDisabled = ConvertToGreyscale

    def AdjustChannels(self, fr=1.0, fg=1.0, fb=1.0, fa=1.0):
        px = self._pixels()
        i = Image(self._w, self._h)
        out = bytearray(px)
        for k, f in enumerate((fr, fg, fb, fa)):
            if f != 1.0:
                out[k::4] = bytes(min(255, int(v * f)) for v in px[k::4])
        i._rgba = out
        return i

    def ConvertToBitmap(self, *_):
        return Bitmap(self)

    def LoadFile(self, name, *_):
        if hasattr(name, "read"):
            data = name.read()
            self._set_src("data:image/png;base64," + _b64.b64encode(bytes(data)).decode("ascii"))
            return True
        return self._load(name)

    LoadStream = LoadFile
    SetOption = SetMaskColour = SetMask = lambda self, *a: None
    HasMask = lambda self: False


class Icon(Bitmap):
    def CopyFromBitmap(self, bmp):
        self._take(bmp)


class BitmapBundle(Bitmap):
    @staticmethod
    def FromBitmap(b):
        return BitmapBundle(b)

    FromSVGFile = staticmethod(lambda path, size=None: Bitmap(path))

    @staticmethod
    def FromSVG(data, sizeDef=None):
        """A bundle from SVG text: drawn at the size asked for (wx.svg does the drawing)."""
        from wx.svg import SVGimage
        raw = data if isinstance(data, (bytes, bytearray)) else str(data).encode("utf-8")
        size = Size(*sizeDef) if isinstance(sizeDef, (tuple, list)) else (sizeDef or Size(24, 24))
        return BitmapBundle(SVGimage.CreateFromBytes(bytes(raw)).ConvertToScaledBitmap(size))

    def GetBitmap(self, *_):
        return Bitmap(self)


NullBitmap = Bitmap()
NullIcon = Icon()
NullImage = Image()
EmptyBitmap = lambda w, h, *_: Bitmap(w, h)
EmptyImage = lambda w=0, h=0, *_: Image(w, h)
EmptyIcon = lambda: Icon()
BitmapFromImage = lambda img: Bitmap(img)
ImageFromBitmap = lambda bmp: Image(bmp)
InitAllImageHandlers = lambda: None
ART_INFORMATION, ART_WARNING, ART_ERROR, ART_QUESTION, ART_FILE_OPEN, ART_FOLDER, ART_FOLDER_OPEN, ART_TIP, ART_GO_UP, ART_GO_DOWN, ART_DELETE, ART_PLUS, ART_MINUS = (
    "info", "warning", "error", "question", "open", "folder", "folder", "tip", "up", "down", "delete", "plus", "minus")
ART_FILE_SAVE, ART_FILE_SAVE_AS, ART_NEW, ART_COPY, ART_CUT, ART_PASTE, ART_UNDO, ART_REDO, ART_FIND, ART_CLOSE, ART_QUIT, ART_HELP = (
    "save", "save", "new", "copy", "cut", "paste", "undo", "redo", "find", "close", "close", "help")
ART_OTHER, ART_BUTTON, ART_MESSAGE_BOX, ART_TOOLBAR, ART_MENU, ART_CMN_DIALOG, ART_FRAME_ICON = "other", "button", "msgbox", "toolbar", "menu", "dialog", "frame"


class ArtProvider:
    GetBitmap = staticmethod(lambda *a, **k: Bitmap())
    GetIcon = staticmethod(lambda *a, **k: Icon())
    GetBitmapBundle = staticmethod(lambda *a, **k: BitmapBundle())
    GetDIPSizeHint = staticmethod(lambda *a, **k: Size(24, 24))
    GetNativeSizeHint = GetSizeHint = GetDIPSizeHint
    GetNativeDIPSizeHint = GetDIPSizeHint


# ----------------------------------------------------------------------------- events

class PyEventBinder:
    def __init__(self, name, command=True):
        self.name, self.command = name, command
        self.typeId = hash(name) & 0xFFFF
        self.evtType = [self.typeId]

    def Bind(self, target, id1, id2, function):
        target.Bind(self, function, id=id1)

    def __repr__(self):
        return f"wx.{self.name}"


_binders = {}


def _binder(name, command=True):
    b = _binders.get(name)
    if b is None:
        b = _binders[name] = PyEventBinder(name, command)
    return b


for _n in ("SPLITTER_SASH_POS_CHANGED", "SPLITTER_SASH_POS_CHANGING", "SPLITTER_SASH_POS_RESIZE", "SPLITTER_DOUBLECLICKED", "SPLITTER_DCLICK", "SPLITTER_UNSPLIT"):
    globals().setdefault("EVT_" + _n, _binder("EVT_" + _n))
for _n in ("BUTTON", "CHECKBOX", "CHOICE", "COMBOBOX", "TEXT", "TEXT_ENTER", "RADIOBUTTON", "RADIOBOX", "SPINCTRL", "SPINCTRLDOUBLE", "SLIDER", "SCROLL",
           "SCROLL_CHANGED", "SCROLL_THUMBTRACK", "LISTBOX", "LISTBOX_DCLICK", "CHECKLISTBOX", "TOGGLEBUTTON", "MENU", "TOOL", "NOTEBOOK_PAGE_CHANGED",
           "NOTEBOOK_PAGE_CHANGING", "LIST_ITEM_SELECTED", "LIST_ITEM_DESELECTED", "LIST_ITEM_ACTIVATED", "LIST_COL_CLICK", "FILEPICKER_CHANGED",
           "DIRPICKER_CHANGED", "COLOURPICKER_CHANGED", "HYPERLINK", "SEARCH", "SEARCHCTRL_SEARCH_BTN", "SEARCHCTRL_CANCEL_BTN", "COMBOBOX_DROPDOWN",
           "COMBOBOX_CLOSEUP", "SPIN", "SPIN_UP", "SPIN_DOWN", "COLLAPSIBLEPANE_CHANGED", "TREE_SEL_CHANGED", "TREE_ITEM_ACTIVATED", "CHOICEBOOK_PAGE_CHANGED",
           "TEXT_MAXLEN", "TEXT_URL", "DATE_CHANGED", "COMMAND_SCROLL", "LIST_ITEM_CHECKED", "LIST_ITEM_UNCHECKED", "LIST_ITEM_RIGHT_CLICK"):
    globals()["EVT_" + _n] = _binder("EVT_" + _n)
for _n in ("CLOSE", "SIZE", "PAINT", "SHOW", "ACTIVATE", "IDLE", "TIMER", "INIT_DIALOG", "KEY_DOWN", "KEY_UP", "CHAR", "CHAR_HOOK", "LEFT_DOWN", "LEFT_UP",
           "LEFT_DCLICK", "RIGHT_DOWN", "RIGHT_UP", "MOTION", "MOUSEWHEEL", "ENTER_WINDOW", "LEAVE_WINDOW", "SET_FOCUS", "KILL_FOCUS", "MOVE", "ERASE_BACKGROUND",
           "UPDATE_UI", "WINDOW_DESTROY", "MOUSE_EVENTS", "CONTEXT_MENU", "MAXIMIZE", "ICONIZE", "SYS_COLOUR_CHANGED", "DPI_CHANGED", "MIDDLE_DOWN", "MIDDLE_UP",
           "END_PROCESS", "THREAD", "CHILD_FOCUS", "DROP_FILES", "MENU_OPEN", "MENU_CLOSE", "MENU_HIGHLIGHT", "SCROLLWIN", "MOUSE_CAPTURE_LOST"):
    globals()["EVT_" + _n] = _binder("EVT_" + _n, False)
EVT_COMMAND_SCROLL_CHANGED = EVT_SCROLL_CHANGED          # noqa: F821
EVT_HOTKEY = _binder("EVT_HOTKEY", False)
wxEVT_COMMAND_BUTTON_CLICKED = wxEVT_BUTTON = EVT_BUTTON.typeId          # noqa: F821
wxEVT_CLOSE_WINDOW = EVT_CLOSE.typeId          # noqa: F821
wxEVT_NULL = 0


def NewEventType():
    return NewId()


def _binder_for_type(type_id):
    """The binder that stands for a raw event type id, made on first use (wx.NewEventType / NewId ids)."""
    type_id = int(type_id)
    for b in _binders.values():
        if b.typeId == type_id:
            return b
    b = _binders["wxEVT_%d" % type_id] = PyEventBinder("wxEVT_%d" % type_id, False)
    b.typeId, b.evtType = type_id, [type_id]
    return b


class Event:
    def __init__(self, source=None, binder=None, eid=None, id=None, commandEventType=None, eventType=None, winid=None, **_more):
        # wxPython's own spellings: wx.CommandEvent(commandEventType=…, id=…), wx.PyEvent(id=…, eventType=…)
        if eid is None:
            eid = id if id is not None else winid
        kind = commandEventType if commandEventType is not None else eventType
        if kind is not None and source is None:
            source = int(kind)
        if isinstance(source, int):           # wx.CommandEvent(eventType, id)
            eid = binder if isinstance(binder, int) else (eid if eid is not None else 0)
            binder = next((b for b in _binders.values() if b.typeId == source), None)
            source = None
        self._source, self._binder, self._skipped, self._vetoed = source, binder, False, False
        self._wx_id = eid if eid is not None else (source.GetId() if source is not None else ID_ANY)
        self._string, self._int, self._wx_key, self._wx_data = "", 0, 0, None

    def GetEventObject(self):
        return self._source

    def SetEventObject(self, o):
        self._source = o

    def GetEventType(self):
        return self._binder.typeId if self._binder else 0

    def SetEventType(self, type_id):
        self._binder = _binder_for_type(type_id) if type_id else None

    def GetId(self):
        return self._wx_id

    def SetId(self, i):
        self._wx_id = i

    def Skip(self, skip=True):
        self._skipped = skip

    def GetSkipped(self):
        return self._skipped

    def Veto(self, veto=True):
        self._vetoed = veto

    def CanVeto(self):
        return True

    def IsAllowed(self):
        return not self._vetoed

    def Allow(self):
        self._vetoed = False

    def StopPropagation(self):
        pass

    def GetString(self):
        s = self._source
        if self._string:
            return self._string
        for m in ("GetStringSelection", "GetValue", "GetLabel"):
            if s is not None and hasattr(type(s), m):
                try:
                    return str(getattr(s, m)())
                except Exception:
                    pass
        return ""

    def GetInt(self):
        s = self._source
        for m in ("GetSelection", "GetValue"):
            if s is not None and hasattr(type(s), m):
                try:
                    return int(getattr(s, m)())
                except Exception:
                    pass
        return self._int

    GetSelection = GetInt
    GetPosition = lambda self: Point(0, 0)
    GetIndex = GetInt
    GetColumn = lambda self: self.__dict__.get("_column", 0)

    def IsChecked(self):
        s = self._source
        return bool(s.GetValue()) if s is not None and hasattr(type(s), "GetValue") else False

    Checked = IsChecked

    def GetKeyCode(self):
        return self._wx_key

    GetUnicodeKey = GetKeyCode
    ControlDown = ShiftDown = AltDown = CmdDown = MetaDown = lambda self: False

    def GetClientData(self):
        return self._wx_data

    def GetValue(self):
        s = self._source
        return s.GetValue() if s is not None and hasattr(type(s), "GetValue") else None

    def Clone(self):
        return self

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


CommandEvent = PyCommandEvent = PyEvent = CloseEvent = KeyEvent = MouseEvent = SizeEvent = TimerEvent = ShowEvent = FocusEvent = ScrollEvent = ListEvent = NotifyEvent = Event
ThreadEvent = Event


def _binder_of(type_id):
    """The binder (EVT_X) of an event type number (wxEVT_X), for events a plugin makes itself: wx.KeyEvent(wx.wxEVT_CHAR_HOOK)."""
    for value in list(globals().values()):
        if isinstance(value, PyEventBinder) and getattr(value, "typeId", None) == type_id:
            return value
    return None


def PostEvent(target, event):
    if target is not None and (event._binder is not None or target is _pcb_frame):
        target._wx_fire(event._binder, event)


QueueEvent = PostEvent


class EvtHandler:
    def __init__(self):
        self._wx_handlers = []

    def Bind(self, event, handler, source=None, id=ID_ANY, id2=ID_ANY):
        if handler is None:
            return self.Unbind(event, source, id)
        self._wx_handlers.append((event, handler, source, id))

    def Unbind(self, event, source=None, id=ID_ANY, id2=ID_ANY, handler=None):
        n = len(self._wx_handlers)
        self._wx_handlers = [h for h in self._wx_handlers if not (h[0] is event and (source is None or h[2] is source) and (handler is None or h[1] == handler))]
        return len(self._wx_handlers) != n

    def Connect(self, id1, id2, evtType, func):
        """The old spelling of Bind: handlers are kept per raw event type id."""
        self.Bind(_binder_for_type(evtType), func, id=id1)

    def Disconnect(self, id1=ID_ANY, id2=ID_ANY, evtType=0, func=None):
        return self.Unbind(_binder_for_type(evtType), id=id1, handler=func) if evtType else False

    def _wx_parent_handler(self):
        return None

    def _wx_fire(self, binder, event=None):
        """Run the handlers bound for `binder`, nearest first.  Returns True when one handled it."""
        if event is None:
            event = Event(self, binder)
        event._binder = binder
        origin = event._source if event._source is not None else self
        target, handled = self, False
        while target is not None:
            for ev, fn, src, eid in list(target._wx_handlers):
                if ev is not binder or (src is not None and src is not origin):
                    continue
                if target is not origin and src is None and eid != ID_ANY and eid != event._wx_id:
                    continue
                if target is origin and eid != ID_ANY and eid != event._wx_id:
                    continue
                event._skipped = False
                _call(fn, event)
                handled = True
                if not event._skipped:
                    return True
            if not binder.command:
                break
            target = target._wx_parent_handler()
        return handled and not event._skipped

    def ProcessEvent(self, event):
        return self._wx_fire(event._binder, event) if event._binder else False

    def AddPendingEvent(self, event):
        self.ProcessEvent(event)

    QueueEvent = AddPendingEvent
    GetEventHandler = lambda self: self
    @staticmethod
    def AddFilter(f):
        """An event filter sees events before the window they are for.  The events of the board editor's own window
        (a click on the canvas, a key) are shown to filters; see _editor_canvas_event."""
        if f is not None and f not in _filters:
            _filters.append(f)

    @staticmethod
    def RemoveFilter(f):
        if f in _filters:
            _filters.remove(f)
    SetEvtHandlerEnabled = lambda self, on: None


def _call(fn, *a):
    try:
        if _before_event is not None:
            _before_event()
        fn(*a)
        _flush_log()
    finally:
        if _after_event is not None:
            _after_event()


# ----------------------------------------------------------------------------- windows

_top_windows = []
_CSS = """
.wx-top{display:none;flex-direction:column;min-height:100%;padding:8px 10px;gap:0}
.wx-top.wx-shown{display:flex}
.wx-sizer{display:flex;min-width:0;min-height:0}
.wx-v{flex-direction:column}.wx-h{flex-direction:row;align-items:flex-start}
.wx-grid{display:grid;align-items:center}
.wx-panel{display:flex;flex-direction:column;min-width:0}
.wx-box{border:1px solid var(--line);border-radius:3px;padding:6px 8px;margin:0;min-width:0;display:flex;flex-direction:column}
.wx-box>legend{padding:0 4px;color:var(--ink-2)}
.wx-check{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.wx-check input{margin:0}
.wx-text{white-space:pre-wrap}
.wx-line{border:0;border-top:1px solid var(--line);margin:4px 0;align-self:stretch}
.wx-line.wx-vline{border-top:0;border-left:1px solid var(--line);margin:0 4px}
.wx-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:6px}
.wx-tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;padding:4px 10px}
.wx-tabs button.on{border-bottom-color:var(--blue);color:var(--ink)}
.wx-page[hidden]{display:none}
.wx-book{display:flex;flex-direction:column;min-height:0}
.wx-book>.wx-page{flex:1 1 auto;min-height:0}
.wx-book>textarea.wx-page{resize:none}
.wx-top>.wx-panel:only-child{flex:1 1 auto;min-height:0}
.wx-list{min-height:60px;overflow:auto;border:1px solid var(--line);border-radius:3px;background:var(--panel)}
.wx-list label{display:flex;gap:5px;align-items:center;padding:1px 6px}
.wx-table{overflow:auto;border:1px solid var(--line);border-radius:3px;min-height:60px;max-height:min(62vh,640px)}
.wx-table tr.sel td{background:color-mix(in srgb,var(--blue) 25%,transparent)}
.wx-table td input{width:100%;border:0;background:none;padding:1px 2px}
.wx-table table{border-collapse:collapse;width:100%}
.wx-table th{position:sticky;top:0;background:var(--panel);border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:2px 6px;font-weight:600;text-align:left;white-space:nowrap}
.wx-tree-exp{display:inline-block;width:14px;cursor:pointer;color:var(--ink2,inherit)}
.wx-tree td{cursor:default}
.wx-table td input.wx-tree-chk{width:auto;margin:0 5px 0 0;vertical-align:middle}
.wx-table td{border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);padding:1px 6px;white-space:nowrap}
.wx-grid-table td{border-right:1px solid color-mix(in srgb,var(--line) 60%,transparent);padding:0 2px}
.wx-grid-table td select{width:100%;border:0;background:none}
.wx-grid-table tr>th:first-child{position:sticky;left:0;color:var(--ink-2);font-weight:400;text-align:right}
.wx-menu-veil{position:fixed;inset:0;z-index:50}
.wx-menu{position:fixed;display:flex;flex-direction:column;min-width:140px;max-height:90vh;overflow:auto;padding:3px;background:var(--paper);border:1px solid var(--line);border-radius:4px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.wx-menu button,.wx-menu-in button{border:0;background:none;text-align:left;padding:3px 10px;border-radius:3px;white-space:nowrap}
.wx-menu button:hover:not(:disabled),.wx-menu-in button:hover:not(:disabled){background:color-mix(in srgb,var(--blue) 22%,transparent)}
.wx-menu hr{border:0;border-top:1px solid var(--line);margin:3px 0;width:100%}
.wx-menu-sub{padding:3px 10px 1px;color:var(--ink-2);font-size:11px}
.wx-menu-in{display:flex;flex-direction:column;padding-left:10px}
.wx-menubar{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:-4px -4px 6px;order:-2}
.wx-menubar button{border:0;background:none;padding:2px 8px;border-radius:3px}
.wx-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:3px;padding:2px 0 6px;order:-1}
.wx-toolbar button{min-width:28px;padding:3px 6px;display:inline-flex;align-items:center;justify-content:center}
.wx-toolbar img{width:20px;height:20px;object-fit:contain}
.wx-toolsep{width:1px;align-self:stretch;background:var(--line);margin:0 3px}
.wx-split{display:flex;gap:6px;min-width:0;min-height:0}
.wx-infobar{display:flex;align-items:center;gap:8px;padding:4px 8px;border:1px solid var(--line);border-radius:3px;background:var(--panel)}
.wx-infobar.warn{border-color:var(--warn)}
.wx-infobar span{flex:1 1 0}
.wx-infobar button{border:0;background:none;padding:0 4px}
.wx-popup{position:fixed;z-index:40;background:var(--paper);border:1px solid var(--line);border-radius:4px;padding:6px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
button.primary{background:var(--blue);border-color:var(--blue);color:var(--on-accent,#fff)}
.wx-stub{border:1px dashed var(--line);border-radius:3px;color:var(--ink-3);padding:4px 6px;font-size:11px}
.wx-html{border:1px solid var(--line);border-radius:3px;width:100%;min-height:140px;flex:1 1 auto;color-scheme:light;background:Canvas}
.wx-stdbtns{display:flex;justify-content:flex-end;gap:6px;align-self:stretch;padding-top:6px}
textarea{resize:vertical;min-height:60px}
select[multiple]{min-height:70px}
.wx-painted{position:relative;isolation:isolate}
.wx-canvas{position:absolute;left:0;top:0;width:100%;height:100%;z-index:-1;pointer-events:none}
[hidden]{display:none!important}
"""
_css_done = [False]


def _ensure_css():
    if _DOM and not _css_done[0]:
        _css_done[0] = True
        s = _js.document.createElement("style")
        s.textContent = _CSS
        _js.document.head.appendChild(s)


def _px(v):
    return f"{int(v)}px"


_PROBED = frozenset((
    "GetValue", "SetValue", "Value", "GetSelection", "SetSelection", "Selection", "GetStringSelection", "SetStringSelection",
    "StringSelection", "GetSelections", "GetPath", "Path", "GetColour", "Colour", "GetItems", "Items",
    "GetCount", "GetString", "GetStrings", "IsChecked", "GetCheckedItems", "GetCheckedStrings", "Get3StateValue", "GetTextValue",
    "GetToggleValue", "GetSelectedFont", "GetFilename", "GetMin", "GetMax", "GetRange", "GetInsertionPoint", "GetLineText",
    "GetNumberOfLines", "GetPageCount", "GetCurrentPage", "GetItemCount", "GetFirstSelected", "GetCellValue", "GetNumberRows", "GetURL"))


class Window(EvtHandler):
    _TAG = "div"
    _CLS = "wx-panel"

    InheritAttributes = lambda self: None
    ShouldInheritColours = lambda self: True

    def __init__(self, parent=None, id=ID_ANY, pos=DefaultPosition, size=DefaultSize, style=0, name="", *more, **kw):
        EvtHandler.__init__(self)
        if "name" in kw:
            name = kw.pop("name")
        _ensure_css()
        self._wx_parent = parent if isinstance(parent, Window) else None
        self._wx_id = id if isinstance(id, int) and id != ID_ANY else NewId()
        self._wx_style = style if isinstance(style, int) else 0
        self._wx_name = name if isinstance(name, str) else ""
        if not self._wx_name:           # given by position, after the arguments particular to the widget (and a validator)
            self._wx_name = next((m for m in reversed(more) if isinstance(m, str)), "")
        self._wx_children = []
        self._wx_sizer = None
        self._wx_shown = True
        self._wx_enabled = True
        self._wx_tooltip = ""
        self._wx_font = None
        self._wx_label = ""
        self._wx_data = None
        self._wx_destroyed = False
        self.el = _el(self._TAG, self._CLS)
        self._wx_build(kw)
        if self._wx_parent is not None:
            self._wx_parent._wx_children.append(self)
            self._wx_parent._wx_adopt(self)
        v = kw.get("validator")
        if v is None:
            v = next((m for m in more if hasattr(m, "TransferToWindow") and hasattr(m, "Clone")), None)
        self._wx_validator = None
        if v is not None and type(v).__name__ != "Validator":
            self.SetValidator(v)
        size = kw.get("size", size)
        if size is not None and tuple(size) != (-1, -1):
            self.SetMinSize(size)

    def SetValidator(self, validator):
        v = validator.Clone() if validator is not None else None
        if v is not None:
            v.SetWindow(self)
        self._wx_validator = v

    def GetValidator(self):
        return self.__dict__.get("_wx_validator")

    def _wx_validators(self):
        out, stack = [], [self]
        while stack:
            w = stack.pop(0)
            v = w.__dict__.get("_wx_validator")
            if v is not None and w.__dict__.get("_wx_enabled", True):
                out.append(v)
            stack[0:0] = [c for c in w.__dict__.get("_wx_children", []) if not isinstance(c, TopLevelWindow)]
        return out

    def Validate(self):
        return all(v.Validate(self) is not False for v in self._wx_validators())

    def TransferDataToWindow(self):
        return all(v.TransferToWindow() is not False for v in self._wx_validators())

    def TransferDataFromWindow(self):
        return all(v.TransferFromWindow() is not False for v in self._wx_validators())

    def InitDialog(self):
        self.TransferDataToWindow()

    def _wx_build(self, kw):
        pass

    def _wx_adopt(self, child):
        if not isinstance(child, TopLevelWindow):
            self.el.appendChild(child.el)

    def _wx_parent_handler(self):
        return self._wx_parent

    def _wx_top(self):
        w = self
        while w is not None and not isinstance(w, TopLevelWindow):
            w = w._wx_parent
        return w

    # identity
    def GetId(self):
        return self._wx_id

    def SetId(self, i):
        self._wx_id = i

    def GetName(self):
        return self._wx_name

    def SetName(self, n):
        self._wx_name = n

    def GetParent(self):
        return self._wx_parent

    GetGrandParent = lambda self: self._wx_parent._wx_parent if self._wx_parent else None

    def GetTopLevelParent(self):
        return self._wx_top()

    def GetChildren(self):
        return list(self._wx_children)

    def FindWindowById(self, i, *_):
        if self._wx_id == i:
            return self
        for c in self._wx_children:
            r = c.FindWindowById(i)
            if r is not None:
                return r
        return None

    FindWindow = FindWindowById

    def FindWindowByName(self, n, *_):
        if self._wx_name == n:
            return self
        for c in self._wx_children:
            r = c.FindWindowByName(n)
            if r is not None:
                return r
        return None

    def Create(self, parent=None, id=ID_ANY, pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        """The second step of wxWidgets' two-step creation: a window made with no arguments is given its parent here."""
        if isinstance(parent, Window) and parent is not self._wx_parent:
            self.Reparent(parent)
        if isinstance(style, int) and style:
            self._wx_style = style
        try:
            if size is not DefaultSize and tuple(size)[:2] != (-1, -1):
                self.SetMinSize(size)
        except Exception:
            pass
        return True

    def Reparent(self, parent):
        if self._wx_parent is not None and self in self._wx_parent._wx_children:
            self._wx_parent._wx_children.remove(self)
        self._wx_parent = parent
        if parent is not None:
            parent._wx_children.append(self)
            parent._wx_adopt(self)
        return True

    # label
    def GetLabel(self):
        return self._wx_label

    GetLabelText = GetLabel

    def SetLabel(self, text):
        self._wx_label = str(text)
        self._wx_show_label()

    SetLabelText = SetLabel
    SetLabelMarkup = SetLabel

    def _wx_show_label(self):
        pass

    # state
    def Show(self, show=True):
        self._wx_shown = bool(show)
        self.el.hidden = not show
        return True

    def Hide(self):
        return self.Show(False)

    def IsShown(self):
        return self._wx_shown

    IsShownOnScreen = IsShown

    def Enable(self, enable=True):
        self._wx_enabled = bool(enable)
        self._wx_set_disabled(not enable)
        for c in self._wx_children:
            c._wx_set_disabled(not enable or not c._wx_enabled)
        return True

    def Disable(self):
        return self.Enable(False)

    def _wx_set_disabled(self, off):
        self.el.disabled = bool(off)

    def IsEnabled(self):
        return self._wx_enabled

    IsThisEnabled = IsEnabled

    def SetFocus(self):
        try:
            self.el.focus()
        except Exception:
            pass

    SetFocusFromKbd = SetFocus
    HasFocus = lambda self: False

    # files dragged from the computer onto the window: wx.FileDropTarget.OnDropFiles gets them as files of this
    # interpreter (under /tmp/dropped), where the plugin opens them as it would the originals
    def SetDropTarget(self, target):
        self._wx_drop = target
        if target is None or not _DOM or getattr(self, "_wx_drop_bound", False):
            return
        self._wx_drop_bound = True

        def over(e):
            e.preventDefault()

        def drop(e):
            e.preventDefault()
            t = getattr(self, "_wx_drop", None)
            files = e.dataTransfer.files if e.dataTransfer else None
            if t is None or files is None or not hasattr(t, "OnDropFiles"):
                return
            import os as _os
            paths = []
            _os.makedirs("/tmp/dropped", exist_ok=True)
            for i in range(min(int(files.length), 40)):
                f = files.item(i)
                if f.size > 64 * 1024 * 1024:
                    continue
                data = _wait(f.arrayBuffer()).to_py()
                path = _os.path.join("/tmp/dropped", _os.path.basename(str(f.name)) or "file")
                with open(path, "wb") as out:
                    out.write(bytes(data))
                paths.append(path)
            if paths:
                t.OnDropFiles(int(getattr(e, "offsetX", 0) or 0), int(getattr(e, "offsetY", 0) or 0), paths)

        self.el.addEventListener("dragover", __import__("pyodide.ffi", fromlist=["create_proxy"]).create_proxy(over))
        _listen(self.el, "drop", drop)

    def GetDropTarget(self):
        return getattr(self, "_wx_drop", None)

    DragAcceptFiles = lambda self, accept=True: None

    def SetToolTip(self, tip):
        self._wx_tooltip = tip if isinstance(tip, str) else getattr(tip, "_text", "")
        self.el.title = self._wx_tooltip

    SetToolTipString = SetToolTip
    SetHelpText = lambda self, t: None

    def GetToolTipText(self):
        return self._wx_tooltip

    def GetToolTip(self):
        return ToolTip(self._wx_tooltip)

    def SetFont(self, font):
        self._wx_font = font
        if isinstance(font, Font):
            font._apply(self.el)
        return True

    def GetFont(self):
        return self._wx_font or Font()

    def SetForegroundColour(self, c):
        self.el.style.color = Colour(c)._css() if c is not None else ""
        return True

    SetOwnForegroundColour = SetForegroundColour

    def SetBackgroundColour(self, c):
        self.el.style.background = Colour(c)._css() if c is not None else ""
        return True

    SetOwnBackgroundColour = SetBackgroundColour
    GetForegroundColour = lambda self: SystemSettings.GetColour(SYS_COLOUR_WINDOWTEXT)
    GetBackgroundColour = lambda self: SystemSettings.GetColour(SYS_COLOUR_WINDOW)

    # geometry: the browser lays things out; sizes given by a plugin are kept as minimums
    def SetMinSize(self, size):
        w, h = tuple(size)[:2]
        self.__dict__["_wx_min"] = (w, h)
        if w is not None and w > 0:
            self.el.style.minWidth = _px(min(w, 900))
        if h is not None and h > 0:
            self.el.style.minHeight = _px(min(h, 700))

    def SetMaxSize(self, size):
        w, h = tuple(size)[:2]
        if w is not None and w > 0:
            self.el.style.maxWidth = _px(w)
        if h is not None and h > 0:
            self.el.style.maxHeight = _px(h)

    def SetSize(self, *a):
        if len(a) == 1:
            self.SetMinSize(a[0])
        elif len(a) == 2:
            self.SetMinSize(a)
        elif len(a) >= 4:
            self.SetMinSize(a[2:4])

    SetInitialSize = SetClientSize = SetBestSize = SetSizeWH = SetVirtualSize = SetSize

    def SetSizeHints(self, *a, **k):
        if a and isinstance(a[0], (tuple, list, Size)):
            self.SetMinSize(a[0])
        elif len(a) >= 2:
            self.SetMinSize(a[:2])

    SetSizeHintsSz = SetSizeHints

    def _wx_box(self):
        if _DOM:
            r = self.el.getBoundingClientRect()
            return int(r.width), int(r.height)
        w, h = self.__dict__.get("_wx_min") or (-1, -1)
        return (int(w) if w and w > 0 else 100), (int(h) if h and h > 0 else 24)

    def GetSize(self):
        return Size(*self._wx_box())

    GetClientSize = GetBestSize = GetMinSize = GetVirtualSize = GetEffectiveMinSize = GetBestVirtualSize = GetMaxSize = GetSize
    GetSizeTuple = lambda self: tuple(self._wx_box())
    GetClientRect = lambda self: Rect(0, 0, *self._wx_box())

    def _wx_origin(self):
        """Where this window is in the page (the page stands for the screen)."""
        if _DOM:
            try:
                r = self.el.getBoundingClientRect()
                return int(r.left), int(r.top)
            except Exception:
                pass
        return 0, 0

    def GetScreenPosition(self):
        return Point(*self._wx_origin())

    def GetScreenRect(self):
        return Rect(*self._wx_origin(), *self._wx_box())

    def GetPosition(self):
        x, y = self._wx_origin()
        if self._wx_parent is not None and not isinstance(self, TopLevelWindow):
            px, py = self._wx_parent._wx_origin()
            return Point(x - px, y - py)
        return Point(x, y)

    def GetRect(self):
        p = self.GetPosition()
        return Rect(p.x, p.y, *self._wx_box())

    def ScreenToClient(self, *a):
        x, y = _xy(a)
        ox, oy = self._wx_origin()
        return Point(int(x) - ox, int(y) - oy)

    def ClientToScreen(self, *a):
        x, y = _xy(a)
        ox, oy = self._wx_origin()
        return Point(int(x) + ox, int(y) + oy)

    def SetPosition(self, *a):
        """Put a child window at a point of its parent (a window that floats over its siblings, not one a sizer places)."""
        if isinstance(self, TopLevelWindow):
            return
        x, y = _xy(a)
        if self._wx_parent is not None and not str(self._wx_parent.el.style.position or ""):
            self._wx_parent.el.style.position = "relative"
        self.el.style.position = "absolute"
        self.el.style.left, self.el.style.top = "%dpx" % int(x), "%dpx" % int(y)

    Move = SetPosition

    def Raise(self):
        self.el.style.zIndex = "5"

    def Lower(self):
        self.el.style.zIndex = ""

    def FitInside(self):
        self.Layout()
    GetTextExtent = lambda self, text: Size(int(len(str(text)) * 7), 16)
    GetFullTextExtent = lambda self, text, *_: (int(len(str(text)) * 7), 16, 0, 0)
    GetCharWidth = lambda self: 7
    GetCharHeight = lambda self: 16
    GetDPIScaleFactor = GetContentScaleFactor = lambda self: 1.0
    FromDIP = ToDIP = ConvertDialogToPixels = ConvertPixelsToDialog = lambda self, v, *_: v

    # sizers
    def SetSizer(self, sizer, deleteOld=True):
        self._wx_sizer = sizer
        if sizer is not None:
            sizer._wx_owner = self
            self._wx_host_el().appendChild(sizer.el)
            sizer.el.style.flex = "1 1 auto"

    def SetSizerAndFit(self, sizer, *_):
        self.SetSizer(sizer)

    def _wx_host_el(self):
        return self.el

    def GetSizer(self):
        return self._wx_sizer

    def GetContainingSizer(self):
        return getattr(self, "_wx_in_sizer", None)

    def Layout(self):
        return True

    def SendSizeEvent(self, *_):
        self.Layout()

    SendSizeEventToParent = PostSizeEvent = PostSizeEventToParent = SendSizeEvent

    def FitInside(self):
        return None

    def Fit(self):
        t = self._wx_top()
        if t is not None and t is not self:
            t._wx_refit()

    def Destroy(self):
        self._wx_destroyed = True
        try:
            self.el.remove()
        except Exception:
            pass
        if self._wx_parent is not None and self in self._wx_parent._wx_children:
            self._wx_parent._wx_children.remove(self)
        return True

    DestroyLater = Destroy

    def DestroyChildren(self):
        for c in list(self._wx_children):
            c.Destroy()
        return True

    def IsBeingDeleted(self):
        return self._wx_destroyed

    def __bool__(self):
        return not self._wx_destroyed

    def Close(self, force=False):
        return True

    def SetClientData(self, d):
        self._wx_data = d

    def GetClientData(self):
        return self._wx_data

    def GetWindowStyle(self):
        return self._wx_style

    GetWindowStyleFlag = GetWindowStyle

    def SetWindowStyle(self, s):
        self._wx_style = s

    SetWindowStyleFlag = SetWindowStyle
    HasFlag = lambda self, f: bool(self._wx_style & f)

    def ToggleWindowStyle(self, flag):
        self._wx_style ^= flag
        return bool(self._wx_style & flag)

    def GetHandle(self):
        return 0

    def PopupMenu(self, menu, *a):
        return _wx_popup_menu(self, menu, a[0] if a and isinstance(a[0], Point) else None)

    # -- a window that draws itself, and hears the mouse (wx/_paint.py)
    def Bind(self, event, handler, source=None, id=ID_ANY, id2=ID_ANY):
        EvtHandler.Bind(self, event, handler, source, id, id2)
        if handler is not None and not getattr(event, "command", True):
            _paint.wire(source if isinstance(source, Window) else self, event)

    def Refresh(self, *a, **k):
        _paint.schedule_paint(self)
        for c in self._wx_children:
            if c.__dict__.get("_wx_canvas") is not None:
                _paint.schedule_paint(c)

    RefreshRect = Refresh

    def Update(self):
        if self.__dict__.get("_wx_paint_due"):
            _paint.paint_now(self)

    def SetBackgroundStyle(self, style):
        self.__dict__["_wx_bg_style"] = style
        return True

    def GetBackgroundStyle(self):
        return self.__dict__.get("_wx_bg_style", 0)

    def InvalidateBestSize(self):
        if self.__dict__.get("_wx_best_done"):
            self.__dict__["_wx_best_done"] = False
            _paint._best_size(self)

    def CaptureMouse(self):
        self.__dict__["_wx_captured"] = True

    def ReleaseMouse(self):
        self.__dict__["_wx_captured"] = False

    def HasCapture(self):
        return bool(self.__dict__.get("_wx_captured"))

    def SetDoubleBuffered(self, *_):
        pass

    IsDoubleBuffered = lambda self: True

    def __getattr__(self, name):
        # Layout and look calls that mean nothing in a browser (Centre, Thaw, …) are accepted.
        if name.startswith("_") or name in ("el",):
            raise AttributeError(name)
        if name[:1].isupper():
            # wxPython gives every GetX/SetX pair a property X (spin.Value, text.Label, win.Size, …)
            getter = getattr(type(self), "Get" + name, None) or getattr(type(self), "Is" + name, None)
            if getter is not None:
                return getter(self)
            _missing.add(f"{type(self).__name__}.{name}")
            # Plugins ask a control what kind it is with hasattr(control, "GetValue") and the like; a control that
            # does not hold a value, a selection or a path must say so, as wxPython's does.
            if name in _PROBED:
                raise AttributeError(f"'{type(self).__name__}' object has no attribute '{name}'")
            return _NULL
        raise AttributeError(name)

    def __setattr__(self, name, value):
        if name[:1].isupper():
            cls = type(self)
            if not hasattr(cls, name):
                setter = getattr(cls, "Set" + name, None)
                if setter is not None:
                    setter(self, value)
                    return
        object.__setattr__(self, name, value)


class _ControlMeta(type):
    """Every widget here is built on Window, so "is this a control?" (as opposed to a panel, a frame or a bare window
    that is drawn on) is answered by what the window is."""

    def __instancecheck__(cls, obj):
        if cls is Control:
            return (isinstance(obj, Window) and type(obj) is not Window and not getattr(obj, "_wx_plain", False)
                    and not isinstance(obj, (Panel, TopLevelWindow)))
        return type.__instancecheck__(cls, obj)


class Control(Window, metaclass=_ControlMeta):
    pass


PyWindow = Window
PyControl = Control


class Panel(Window):
    pass


PyPanel = Panel


class ScrolledWindow(Panel):
    """A panel that scrolls.  One that holds widgets scrolls as the page does.  One that paints itself (EVT_PAINT) has a
    virtual size larger than what shows: its view start moves with the wheel and the window repaints, as wx does it."""

    def _wx_build(self, kw):
        self.el.style.overflow = "auto"
        self.__dict__.update(_sw_rate=(1, 1), _sw_view=[0, 0], _sw_virtual=None)
        _listen(self.el, "wheel", self._sw_wheel)

    def _sw_painted(self):
        return any(h[0] is EVT_PAINT for h in self._wx_handlers)

    def _sw_client(self):
        try:
            sz = self.GetClientSize()
            return int(sz[0]), int(sz[1])
        except Exception:
            return 0, 0

    def _sw_limit(self, x, y):
        vw, vh = self._sw_virtual or (0, 0)
        cw, ch = self._sw_client()
        rx, ry = self._sw_rate
        mx = max(0, -(-(vw - cw) // rx)) if rx else 0
        my = max(0, -(-(vh - ch) // ry)) if ry else 0
        return max(0, min(int(x), mx)), max(0, min(int(y), my))

    def _sw_wheel(self, e):
        if not self._sw_painted() or any(h[0] is EVT_MOUSEWHEEL for h in self._wx_handlers):
            return
        dy = float(getattr(e, "deltaY", 0) or 0)
        dx = float(getattr(e, "deltaX", 0) or 0)
        rx, ry = self._sw_rate
        before = list(self._sw_view)
        self.Scroll(self._sw_view[0] + (int(round(dx / rx)) or (dx > 0) - (dx < 0)) if rx and dx else self._sw_view[0],
                    self._sw_view[1] + (int(round(dy / ry)) or (dy > 0) - (dy < 0)) if ry and dy else self._sw_view[1])
        if before != self._sw_view and hasattr(e, "preventDefault"):
            e.preventDefault()

    def SetScrollRate(self, x=0, y=0):
        self._sw_rate = (max(0, int(x)), max(0, int(y)))

    def SetScrollbars(self, ppu_x=1, ppu_y=1, units_x=0, units_y=0, x=0, y=0, *_):
        self._sw_rate = (max(0, int(ppu_x)), max(0, int(ppu_y)))
        self.SetVirtualSize(int(ppu_x) * int(units_x), int(ppu_y) * int(units_y))
        self.Scroll(x, y)

    def GetScrollPixelsPerUnit(self):
        return self._sw_rate

    def SetVirtualSize(self, *a):
        sz = a[0] if len(a) == 1 else a
        self._sw_virtual = (int(sz[0]), int(sz[1]))
        self._sw_view[:] = self._sw_limit(*self._sw_view)

    def GetVirtualSize(self):
        if self._sw_virtual:
            cw, ch = self._sw_client()
            return Size(max(self._sw_virtual[0], cw), max(self._sw_virtual[1], ch))
        if _DOM:
            return Size(int(self.el.scrollWidth or 0), int(self.el.scrollHeight or 0))
        return self.GetClientSize()

    def GetViewStart(self):
        if not self._sw_painted() and _DOM:
            rx, ry = self._sw_rate
            return (int((self.el.scrollLeft or 0) // rx) if rx else 0, int((self.el.scrollTop or 0) // ry) if ry else 0)
        return (self._sw_view[0], self._sw_view[1])

    def Scroll(self, x=-1, y=-1):
        if isinstance(x, (tuple, list, Point)):
            x, y = x[0], x[1]
        x = self._sw_view[0] if x is None or x < 0 else x
        y = self._sw_view[1] if y is None or y < 0 else y
        if self._sw_painted():
            new = list(self._sw_limit(x, y))
            if new != self._sw_view:
                self._sw_view[:] = new
                self.Refresh()
            return
        self._sw_view[:] = [int(x), int(y)]
        if _DOM:
            self.el.scrollLeft = int(x) * self._sw_rate[0]
            self.el.scrollTop = int(y) * self._sw_rate[1]

    def CalcUnscrolledPosition(self, *a):
        p = a[0] if len(a) == 1 else a
        vx, vy = self.GetViewStart()
        return Point(int(p[0]) + vx * self._sw_rate[0], int(p[1]) + vy * self._sw_rate[1])

    def CalcScrolledPosition(self, *a):
        p = a[0] if len(a) == 1 else a
        vx, vy = self.GetViewStart()
        return Point(int(p[0]) - vx * self._sw_rate[0], int(p[1]) - vy * self._sw_rate[1])

    def DoPrepareDC(self, dc):
        vx, vy = self.GetViewStart()
        dc.SetDeviceOrigin(-vx * self._sw_rate[0], -vy * self._sw_rate[1])

    PrepareDC = DoPrepareDC
    EnableScrolling = SetupScrolling = ShowScrollbars = SetTargetWindow = lambda self, *a, **k: None


ScrolledPanel = ScrolledWindow


class _Labelled(Window):
    def __init__(self, parent=None, id=ID_ANY, label="", pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        self._init_label = label if isinstance(label, str) else ""
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)
        self.SetLabel(self._init_label)


class StaticText(_Labelled):
    _TAG, _CLS = "div", "wx-text"

    def _wx_build(self, kw):
        if self._wx_style & ALIGN_RIGHT:
            self.el.style.textAlign = "right"
        elif self._wx_style & ALIGN_CENTER_HORIZONTAL:
            self.el.style.textAlign = "center"

    def _wx_show_label(self):
        self.el.textContent = self._wx_label.replace("&&", "\0").replace("&", "").replace("\0", "&")

    def Wrap(self, width):
        if width and width > 0:
            self.el.style.maxWidth = _px(width)

    def _wx_set_disabled(self, off):
        self.el.style.opacity = ".5" if off else ""


class Button(_Labelled):
    _TAG, _CLS = "button", ""
    _STOCK = {ID_OK: "OK", ID_CANCEL: "Cancel", ID_YES: "Yes", ID_NO: "No", ID_APPLY: "Apply", ID_CLOSE: "Close", ID_SAVE: "Save", ID_HELP: "Help",
              ID_OPEN: "Open", ID_ADD: "Add", ID_REMOVE: "Remove", ID_DELETE: "Delete", ID_REFRESH: "Refresh", ID_ABOUT: "About"}

    def _wx_build(self, kw):
        self.el.type = "button"
        if not self._init_label and self._wx_id in self._STOCK:
            self._init_label = self._STOCK[self._wx_id]
        _listen(self.el, "click", self._wx_clicked)

    def _wx_show_label(self):
        self.el.textContent = self._wx_label.replace("&", "")

    def _wx_clicked(self, _ev=None):
        if not self._wx_enabled:
            return
        if not self._wx_fire(EVT_BUTTON, Event(self, EVT_BUTTON)):          # noqa: F821
            top = self._wx_top()
            if top is not None:
                top._wx_default_button(self._wx_id)

    def SetDefault(self):
        self.el.classList.add("primary")
        top = self._wx_top()
        if top is not None:
            top._wx_default = self
        return self

    def SetBitmap(self, bmp, *_):
        self._wx_bitmap = bmp
        _set_img(self.el, bmp, self._wx_label)

    SetBitmapLabel = SetBitmap

    def GetBitmap(self):
        b = getattr(self, "_wx_bitmap", None)
        return b if b is not None else NullBitmap

    GetBitmapLabel = GetBitmap
    SetBitmapMargins = SetBitmapPosition = lambda self, *a: None

    def SetAuthNeeded(self, *_):
        pass


def _set_img(el, bmp, text=""):
    url = getattr(bmp, "_url", "")
    if not url:
        return
    if _DOM:
        img = _js.document.createElement("img")
        img.src = url
        img.style.maxHeight = "20px"
        img.style.verticalAlign = "middle"
        el.replaceChildren(img)
        if text:
            el.append(" " + text.replace("&", ""))


class BitmapButton(Button):
    def __init__(self, parent=None, id=ID_ANY, bitmap=None, pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        Button.__init__(self, parent, id, "", pos, size, style, *more, **kw)
        if bitmap is not None:
            self.SetBitmap(bitmap)
        if not getattr(bitmap, "_url", ""):
            self.el.textContent = "…"


class ToggleButton(Button):
    def _wx_build(self, kw):
        Button._wx_build(self, kw)
        self._on = False

    def _wx_clicked(self, _ev=None):
        self._on = not self._on
        self.el.classList.toggle("primary", self._on)
        self._wx_fire(EVT_TOGGLEBUTTON, Event(self, EVT_TOGGLEBUTTON))          # noqa: F821

    def GetValue(self):
        return self._on

    def SetValue(self, v):
        self._on = bool(v)
        self.el.classList.toggle("primary", self._on)


class CheckBox(_Labelled):
    _TAG, _CLS = "label", "wx-check"
    _KIND = "checkbox"
    _EVT = "EVT_CHECKBOX"

    def _wx_build(self, kw):
        self.input = _el("input")
        self.input.type = self._KIND
        self.text = _el("span")
        self.el.appendChild(self.input)
        self.el.appendChild(self.text)
        _listen(self.input, "change", self._wx_changed)

    def _wx_show_label(self):
        self.text.textContent = self._wx_label.replace("&", "")

    def _wx_changed(self, _ev=None):
        self._wx_fire(_binders[self._EVT], Event(self, _binders[self._EVT]))

    def GetValue(self):
        return bool(self.input.checked)

    IsChecked = GetValue

    def SetValue(self, v):
        # wxPython takes a truth value here only as a bool or a whole number: a string such as "false" is a TypeError
        # there, not a tick (plugins that load settings as text rely on that error leaving the box as it was)
        self.input.checked = self._wx_truth(v)

    def _wx_truth(self, v):
        if not isinstance(v, (bool, int)) and not hasattr(v, "__index__"):
            raise TypeError("%s.SetValue(): argument 1 has unexpected type '%s'" % (type(self).__name__, type(v).__name__))
        return bool(v)

    def Get3StateValue(self):
        return CHK_CHECKED if self.GetValue() else CHK_UNCHECKED

    def Set3StateValue(self, v):
        self.SetValue(v == CHK_CHECKED)

    def _wx_set_disabled(self, off):
        self.input.disabled = bool(off)
        self.el.style.opacity = ".5" if off else ""


class RadioButton(CheckBox):
    _KIND = "radio"
    _EVT = "EVT_RADIOBUTTON"

    def _wx_build(self, kw):
        CheckBox._wx_build(self, kw)
        p = self._wx_parent
        if p is not None:
            if self._wx_style & RB_GROUP or not hasattr(p, "_radio_group"):
                p._radio_group = f"rg{NewId()}"
                self.input.checked = True
            self.input.name = p._radio_group
            self._wx_group = p.__dict__.setdefault("_radio_members", {}).setdefault(p._radio_group, [])
            self._wx_group.append(self)

    def SetValue(self, v):
        # one of a group: turning one on turns the others off (a browser does this for inputs that share a name;
        # said here too so it holds wherever the window is built)
        if self._wx_truth(v):
            for other in getattr(self, "_wx_group", ()):
                if other is not self:
                    other.input.checked = False
        CheckBox.SetValue(self, v)


class TextCtrl(Window):
    def __init__(self, parent=None, id=ID_ANY, value="", pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        self._multi = bool((style if isinstance(style, int) else 0) & TE_MULTILINE)
        self._TAG = "textarea" if self._multi else "input"
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)
        self.SetValue(value if isinstance(value, str) else "")

    _CLS = ""

    def _wx_build(self, kw):
        if not self._multi:
            self.el.type = "password" if self._wx_style & TE_PASSWORD else "text"
        else:
            self.el.rows = 6
            if self._wx_style & HSCROLL:        # wxHSCROLL / wxTE_DONTWRAP: long lines scroll, they are not wrapped
                self.el.wrap = "off"
        if self._wx_style & TE_READONLY:
            self.el.readOnly = True
        self._max = 0
        _listen(self.el, "input", lambda e=None: self._wx_fire(EVT_TEXT, Event(self, EVT_TEXT)))          # noqa: F821
        _listen(self.el, "keydown", self._wx_key)

    def _wx_key(self, ev=None):
        if ev is not None and getattr(ev, "key", "") == "Enter" and not self._multi:
            if self._wx_style & TE_PROCESS_ENTER:
                self._wx_fire(EVT_TEXT_ENTER, Event(self, EVT_TEXT_ENTER))          # noqa: F821
            else:
                top = self._wx_top()
                if top is not None and getattr(top, "_wx_default", None) is not None:
                    top._wx_default._wx_clicked()

    def GetValue(self):
        return str(self.el.value)

    def SetValue(self, v):
        self.el.value = "" if v is None else str(v)

    ChangeValue = SetValue
    GetLineText = lambda self, n: (self.GetValue().split("\n") + [""])[n]
    GetNumberOfLines = lambda self: len(self.GetValue().split("\n"))
    IsEmpty = lambda self: not self.GetValue()
    IsModified = lambda self: True
    GetLastPosition = lambda self: len(self.GetValue())
    GetInsertionPoint = GetLastPosition

    def AppendText(self, t):
        self.el.value = str(self.el.value) + str(t)
        if _DOM:
            self.el.scrollTop = self.el.scrollHeight

    WriteText = write = AppendText

    def flush(self):
        pass

    def Clear(self):
        self.el.value = ""

    def SetEditable(self, on):
        self.el.readOnly = not on

    def IsEditable(self):
        return not bool(getattr(self.el, "readOnly", False))

    def SetMaxLength(self, n):
        self._max = n

    def SetHint(self, hint):
        self.el.placeholder = str(hint)
        return True

    def SelectAll(self):
        try:
            self.el.select()
        except Exception:
            pass

    SetSelection = SetInsertionPoint = SetInsertionPointEnd = ShowPosition = SetDefaultStyle = SetStyle = lambda self, *a: None
    GetStringSelection = lambda self: ""


class SearchCtrl(TextCtrl):
    ShowSearchButton = ShowCancelButton = SetDescriptiveText = lambda self, *a: None


class _Choices(Window):
    """Choice, ComboBox and ListBox share the list-of-strings half."""

    def __init__(self, parent=None, id=ID_ANY, pos=DefaultPosition, size=DefaultSize, choices=None, style=0, *more, **kw):
        self._wx_items = []
        self._wx_client = []
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)
        for c in (kw.get("choices", choices) or []):
            self.Append(c)

    def _wx_option(self, text):
        o = _el("option")
        o.textContent = str(text)
        o.value = str(text)
        return o

    def _wx_list_el(self):
        return self.el

    def Append(self, item, data=None):
        if isinstance(item, (list, tuple)):
            for i in item:
                self.Append(i)
            return len(self._wx_items) - 1
        self._wx_items.append(str(item))
        self._wx_client.append(data)
        self._wx_list_el().appendChild(self._wx_option(item))
        return len(self._wx_items) - 1

    AppendItems = Append

    def Insert(self, item, pos, data=None):
        items, client = list(self._wx_items), list(self._wx_client)
        items.insert(pos, str(item))
        client.insert(pos, data)
        self.Set(items)
        self._wx_client = client
        return pos

    def Set(self, items):
        sel = self.GetStringSelection() if self._wx_items else ""
        self.Clear()
        for i in items:
            self.Append(i)
        if sel in self._wx_items:
            self.SetStringSelection(sel)

    SetItems = Set

    def Clear(self):
        self._wx_items, self._wx_client = [], []
        self._wx_list_el().replaceChildren()

    def Delete(self, n):
        items = list(self._wx_items)
        client = list(self._wx_client)
        del items[n]
        del client[n]
        self.Clear()
        for i, d in zip(items, client):
            self.Append(i, d)

    def GetCount(self):
        return len(self._wx_items)

    def IsEmpty(self):
        return not self._wx_items

    def GetString(self, n):
        return self._wx_items[n] if 0 <= n < len(self._wx_items) else ""

    def SetString(self, n, s):
        items = list(self._wx_items)
        items[n] = str(s)
        self.Set(items)

    def GetStrings(self):
        return list(self._wx_items)

    GetItems = GetStrings

    def FindString(self, s, *_):
        return self._wx_items.index(s) if s in self._wx_items else NOT_FOUND

    def GetSelection(self):
        i = int(self.el.selectedIndex)
        return i if 0 <= i < len(self._wx_items) else NOT_FOUND

    GetCurrentSelection = GetSelection

    def SetSelection(self, n):
        n = int(n)
        if n != -1 and not 0 <= n < len(self._wx_items):
            return          # wxWidgets checks the index and leaves the selection as it was
        self.el.selectedIndex = n

    Select = SetSelection

    def GetStringSelection(self):
        i = self.GetSelection()
        return self._wx_items[i] if 0 <= i < len(self._wx_items) else ""

    def SetStringSelection(self, s):
        if s in self._wx_items:
            self.SetSelection(self._wx_items.index(s))
            return True
        return False

    def GetClientData(self, n=None):
        return self._wx_client[n] if n is not None and 0 <= n < len(self._wx_client) else None

    def SetClientData(self, n, data=None):
        if 0 <= n < len(self._wx_client):
            self._wx_client[n] = data

    GetClientObject, SetClientObject = GetClientData, SetClientData


class Choice(_Choices):
    _TAG, _CLS = "select", ""

    def _wx_build(self, kw):
        _listen(self.el, "change", lambda e=None: self._wx_fire(EVT_CHOICE, Event(self, EVT_CHOICE)))          # noqa: F821

    def Append(self, item, data=None):
        first = not self._wx_items
        r = _Choices.Append(self, item, data)
        if first and not _DOM:
            self.el.selectedIndex = -1
        return r


class ComboBox(_Choices):
    """A read-only combo is a <select>; an editable one is a text field with the choices as suggestions."""

    def __init__(self, parent=None, id=ID_ANY, value="", pos=DefaultPosition, size=DefaultSize, choices=None, style=0, *more, **kw):
        self._ro = bool((style if isinstance(style, int) else 0) & CB_READONLY)
        self._TAG = "select" if self._ro else "input"
        self._CLS = ""
        _Choices.__init__(self, parent, id, pos, size, choices, style, *more, **kw)
        if isinstance(value, str) and value:
            self.SetValue(value)

    def _wx_build(self, kw):
        if not self._ro:
            self._dl = _el("datalist")
            self._dl.id = f"dl{self._wx_id}"
            self.el.setAttribute("list", self._dl.id)
            _listen(self.el, "input", self._wx_typed)
        _listen(self.el, "change", lambda e=None: self._wx_fire(EVT_COMBOBOX, Event(self, EVT_COMBOBOX)))          # noqa: F821

    def _wx_adopt_list(self):
        if not self._ro and self._dl.parentNode is None and self.el.parentNode is not None:
            self.el.parentNode.appendChild(self._dl)

    def _wx_typed(self, _e=None):
        self._wx_fire(EVT_TEXT, Event(self, EVT_TEXT))          # noqa: F821

    def _wx_list_el(self):
        return self.el if self._ro else self._dl

    def Append(self, item, data=None):
        r = _Choices.Append(self, item, data)
        self._wx_adopt_list()
        return r

    def GetValue(self):
        return self.GetStringSelection() if self._ro else str(self.el.value)

    def SetValue(self, v):
        if self._ro:
            self.SetStringSelection(str(v))
        else:
            self.el.value = str(v)

    ChangeValue = SetValue

    def GetSelection(self):
        if self._ro:
            return _Choices.GetSelection(self)
        v = str(self.el.value)
        return self._wx_items.index(v) if v in self._wx_items else NOT_FOUND

    GetCurrentSelection = GetSelection

    def SetSelection(self, n, *_):
        if self._ro:
            _Choices.SetSelection(self, n)
        elif 0 <= n < len(self._wx_items):
            self.el.value = self._wx_items[n]

    Select = SetSelection

    def GetStringSelection(self):
        return _Choices.GetStringSelection(self) if self._ro else str(self.el.value)

    SetEditable = SetHint = Popup = Dismiss = lambda self, *a: None


BitmapComboBox = OwnerDrawnComboBox = ComboBox


class ListBox(_Choices):
    _TAG, _CLS = "select", ""

    def _wx_build(self, kw):
        self.el.size = 6
        if self._wx_style & (LB_MULTIPLE | LB_EXTENDED):
            self.el.multiple = True
        _listen(self.el, "change", lambda e=None: self._wx_fire(EVT_LISTBOX, Event(self, EVT_LISTBOX)))          # noqa: F821
        _listen(self.el, "dblclick", lambda e=None: self._wx_fire(EVT_LISTBOX_DCLICK, Event(self, EVT_LISTBOX_DCLICK)))          # noqa: F821

    def _wx_opts(self):
        return [c for c in (self.el.children if not _DOM else list(self.el.options))]

    def GetSelections(self):
        return [i for i, o in enumerate(self._wx_opts()) if bool(getattr(o, "selected", False))]

    def IsSelected(self, n):
        return n in self.GetSelections()

    def SetSelection(self, n, select=True):
        opts = self._wx_opts()
        if n == NOT_FOUND:
            for o in opts:
                o.selected = False
        elif 0 <= n < len(opts):
            opts[n].selected = bool(select)
            if not _DOM and select:
                self.el.selectedIndex = n

    Select = SetSelection

    def Deselect(self, n):
        self.SetSelection(n, False)

    def DeselectAll(self):
        self.SetSelection(NOT_FOUND)

    def GetSelection(self):
        s = self.GetSelections()
        return s[0] if s else (_Choices.GetSelection(self) if not _DOM else NOT_FOUND)

    EnsureVisible = SetFirstItem = lambda self, *a: None


class CheckListBox(_Choices):
    _TAG, _CLS = "div", "wx-list"

    def _wx_build(self, kw):
        self._boxes = []

    def _wx_option(self, text):
        lab = _el("label")
        box = _el("input")
        box.type = "checkbox"
        span = _el("span")
        span.textContent = str(text)
        lab.appendChild(box)
        lab.appendChild(span)
        self._boxes.append(box)
        _listen(box, "change", lambda e=None: self._wx_fire(EVT_CHECKLISTBOX, Event(self, EVT_CHECKLISTBOX)))          # noqa: F821
        return lab

    def Clear(self):
        self._boxes = []
        _Choices.Clear(self)

    def IsChecked(self, n):
        return bool(self._boxes[n].checked) if 0 <= n < len(self._boxes) else False

    def Check(self, n, check=True):
        if 0 <= n < len(self._boxes):
            self._boxes[n].checked = bool(check)

    def GetCheckedItems(self):
        return tuple(i for i, b in enumerate(self._boxes) if bool(b.checked))

    GetChecked = GetCheckedItems

    def GetCheckedStrings(self):
        return tuple(self._wx_items[i] for i in self.GetCheckedItems())

    def SetCheckedItems(self, idx):
        want = set(idx)
        for i, b in enumerate(self._boxes):
            b.checked = i in want

    SetChecked = SetCheckedItems

    def SetCheckedStrings(self, strings):
        want = set(strings)
        for i, b in enumerate(self._boxes):
            b.checked = self._wx_items[i] in want

    def GetSelection(self):
        return NOT_FOUND

    def SetSelection(self, n):
        pass

    def GetSelections(self):
        return []


class RadioBox(Window):
    _TAG, _CLS = "fieldset", "wx-box"

    def __init__(self, parent=None, id=ID_ANY, label="", pos=DefaultPosition, size=DefaultSize, choices=None, majorDimension=0, style=RA_SPECIFY_COLS, *more, **kw):
        self._choices = list(kw.get("choices", choices) or [])
        self._rlabel = label if isinstance(label, str) else ""
        self._major = majorDimension
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)

    def _wx_build(self, kw):
        leg = _el("legend")
        leg.textContent = self._rlabel
        self.el.appendChild(leg)
        body = _el("div", "wx-sizer " + ("wx-h" if (self._wx_style & RA_SPECIFY_ROWS) or self._major > 1 else "wx-v"))
        body.style.gap = "4px 12px"
        body.style.flexWrap = "wrap"
        self.el.appendChild(body)
        self._inputs = []
        group = f"rb{NewId()}"
        for i, c in enumerate(self._choices):
            lab = _el("label", "wx-check")
            inp = _el("input")
            inp.type = "radio"
            inp.name = group
            inp.checked = i == 0
            sp = _el("span")
            sp.textContent = str(c).replace("&", "")
            lab.appendChild(inp)
            lab.appendChild(sp)
            body.appendChild(lab)
            self._inputs.append(inp)
            _listen(inp, "change", lambda e=None: self._wx_fire(EVT_RADIOBOX, Event(self, EVT_RADIOBOX)))          # noqa: F821

    def GetSelection(self):
        for i, inp in enumerate(self._inputs):
            if bool(inp.checked):
                return i
        return 0

    def SetSelection(self, n):
        for i, inp in enumerate(self._inputs):
            inp.checked = i == n

    def GetStringSelection(self):
        return str(self._choices[self.GetSelection()]) if self._choices else ""

    def SetStringSelection(self, s):
        if s in self._choices:
            self.SetSelection(self._choices.index(s))
            return True
        return False

    def GetCount(self):
        return len(self._choices)

    def GetString(self, n):
        return str(self._choices[n])

    def FindString(self, s, *_):
        return self._choices.index(s) if s in self._choices else NOT_FOUND

    def EnableItem(self, n, enable=True):
        self._inputs[n].disabled = not enable

    def ShowItem(self, n, show=True):
        pass

    def _wx_set_disabled(self, off):
        for inp in self._inputs:
            inp.disabled = bool(off)


class SpinCtrl(Window):
    _TAG, _CLS = "input", ""
    _FLOAT = False

    def __init__(self, parent=None, id=ID_ANY, value="", pos=DefaultPosition, size=DefaultSize, style=SP_ARROW_KEYS, min=0, max=100, initial=0, inc=1, *more, **kw):
        self._lo, self._hi, self._inc = kw.get("min", min), kw.get("max", max), kw.get("inc", inc)
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)
        try:
            start = float(value) if value not in ("", None) else kw.get("initial", initial)
        except (TypeError, ValueError):
            start = kw.get("initial", initial)
        self.SetValue(start)

    def _wx_build(self, kw):
        self.el.type = "number"
        self.el.min, self.el.max, self.el.step = str(self._lo), str(self._hi), str(self._inc if self._FLOAT else 1)
        self.el.style.width = "90px"
        ev = _binders["EVT_SPINCTRLDOUBLE" if self._FLOAT else "EVT_SPINCTRL"]
        _listen(self.el, "change", lambda e=None: (self._wx_fire(ev, Event(self, ev)), self._wx_fire(EVT_TEXT, Event(self, EVT_TEXT))))          # noqa: F821

    def GetValue(self):
        try:
            v = float(self.el.value)
        except (TypeError, ValueError):
            v = float(self._lo)
        v = max(self._lo, min(self._hi, v))
        return v if self._FLOAT else int(round(v))

    def SetValue(self, v):
        try:
            v = float(v)
        except (TypeError, ValueError):
            v = 0.0
        self.el.value = repr(v) if self._FLOAT else str(int(round(v)))

    def SetRange(self, lo, hi):
        self._lo, self._hi = lo, hi
        self.el.min, self.el.max = str(lo), str(hi)

    def SetMin(self, lo):
        self.SetRange(lo, self._hi)

    def SetMax(self, hi):
        self.SetRange(self._lo, hi)

    GetMin = lambda self: self._lo
    GetMax = lambda self: self._hi

    def SetIncrement(self, inc):
        self._inc = inc
        self.el.step = str(inc)

    GetIncrement = lambda self: self._inc
    SetDigits = lambda self, n: None
    GetDigits = lambda self: 2


class SpinCtrlDouble(SpinCtrl):
    _FLOAT = True


SpinButton = SpinCtrl


class Slider(Window):
    _TAG, _CLS = "input", ""

    def __init__(self, parent=None, id=ID_ANY, value=0, minValue=0, maxValue=100, pos=DefaultPosition, size=DefaultSize, style=SL_HORIZONTAL, *more, **kw):
        self._lo, self._hi = kw.get("minValue", minValue), kw.get("maxValue", maxValue)
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)
        self.SetValue(value)

    def _wx_build(self, kw):
        self.el.type = "range"
        self.el.min, self.el.max = str(self._lo), str(self._hi)
        _listen(self.el, "input", lambda e=None: (self._wx_fire(EVT_SLIDER, Event(self, EVT_SLIDER)), self._wx_fire(EVT_SCROLL, Event(self, EVT_SCROLL))))          # noqa: F821
        _listen(self.el, "change", lambda e=None: self._wx_fire(EVT_SCROLL_CHANGED, Event(self, EVT_SCROLL_CHANGED)))          # noqa: F821

    def GetValue(self):
        try:
            return int(float(self.el.value))
        except (TypeError, ValueError):
            return int(self._lo)

    def SetValue(self, v):
        self.el.value = str(int(v))

    def SetRange(self, lo, hi):
        self._lo, self._hi = lo, hi
        self.el.min, self.el.max = str(lo), str(hi)

    SetMin = lambda self, v: self.SetRange(v, self._hi)
    SetMax = lambda self, v: self.SetRange(self._lo, v)
    GetMin = lambda self: self._lo
    GetMax = lambda self: self._hi


class Gauge(Window):
    _TAG, _CLS = "progress", ""

    def __init__(self, parent=None, id=ID_ANY, range=100, pos=DefaultPosition, size=DefaultSize, style=GA_HORIZONTAL, *more, **kw):
        self._range = kw.get("range", range)
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)

    def _wx_build(self, kw):
        self.el.max = self._range
        self.el.value = 0
        self.el.style.width = "100%"
        self._value = 0

    def SetValue(self, v):
        self._value = v
        self.el.value = v
        Yield()

    def GetValue(self):
        return self._value

    def SetRange(self, r):
        self._range = r
        self.el.max = r

    def GetRange(self):
        return self._range

    def Pulse(self):
        if _DOM:
            self.el.removeAttribute("value")
        Yield()


class StaticLine(Window):
    _TAG, _CLS = "hr", "wx-line"

    def _wx_build(self, kw):
        if self._wx_style & LI_VERTICAL:
            self.el.classList.add("wx-vline")


class StaticBitmap(Window):
    _TAG, _CLS = "img", ""

    def __init__(self, parent=None, id=ID_ANY, bitmap=None, pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)
        self.SetBitmap(kw.get("bitmap", bitmap))

    def SetBitmap(self, bmp):
        url = getattr(bmp, "_url", "") if bmp is not None else ""
        if url:
            self.el.src = url
            self.el.style.maxWidth = "100%"
        self.el.hidden = not url

    SetIcon = SetBitmap
    SetScaleMode = lambda self, *_: None


GenericStaticBitmap = StaticBitmap


class StaticBox(Window):
    _TAG, _CLS = "fieldset", "wx-box"

    def __init__(self, parent=None, id=ID_ANY, label="", pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        self._blabel = label if isinstance(label, str) else ""
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)

    def _wx_build(self, kw):
        self._legend = _el("legend")
        self._legend.textContent = self._blabel
        self.el.appendChild(self._legend)

    def SetLabel(self, text):
        self._wx_label = self._blabel = str(text)
        self._legend.textContent = self._blabel

    def GetLabel(self):
        return self._blabel


class DateTime:
    """A moment, as plugins use it: now, formatted or as a number."""

    def __init__(self, *a):
        import datetime as _dt
        self._t = _dt.datetime(*a) if len(a) >= 3 else _dt.datetime.now()

    @staticmethod
    def Now():
        return DateTime()

    UNow = Today = Now

    @staticmethod
    def FromTimeT(seconds):
        import datetime as _dt
        d = DateTime(); d._t = _dt.datetime.fromtimestamp(seconds); return d

    def IsValid(self): return True
    def Format(self, fmt="%c", tz=None): return self._t.strftime(fmt)
    def FormatTime(self): return self._t.strftime("%H:%M:%S")
    def FormatDate(self): return self._t.strftime("%x")
    def FormatISODate(self): return self._t.strftime("%Y-%m-%d")
    def FormatISOTime(self): return self._t.strftime("%H:%M:%S")
    def FormatISOCombined(self, sep="T"): return self._t.strftime("%Y-%m-%d" + sep + "%H:%M:%S")
    def GetTicks(self): return int(self._t.timestamp())
    def GetYear(self): return self._t.year
    def GetMonth(self): return self._t.month - 1
    def GetDay(self): return self._t.day
    def GetHour(self): return self._t.hour
    def GetMinute(self): return self._t.minute
    def GetSecond(self): return self._t.second
    def GetMillisecond(self): return self._t.microsecond // 1000


class HyperlinkCtrl(_Labelled):
    _TAG, _CLS = "a", ""

    def __init__(self, parent=None, id=ID_ANY, label="", url="", pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        self._url = kw.get("url", url)
        _Labelled.__init__(self, parent, id, label or self._url, pos, size, style, *more, **kw)

    def _wx_build(self, kw):
        self.el.title = str(self._url)
        _listen(self.el, "click", lambda e=None: self._wx_fire(EVT_HYPERLINK, Event(self, EVT_HYPERLINK)))          # noqa: F821

    def _wx_show_label(self):
        self.el.textContent = self._wx_label

    def SetNormalColour(self, colour):
        self._normal = Colour(colour)
        self.el.style.color = self._normal.GetAsString()

    def GetNormalColour(self):
        return getattr(self, "_normal", Colour(0, 0, 255))

    def SetVisitedColour(self, colour):
        self._visited = Colour(colour)

    def GetVisitedColour(self):
        return getattr(self, "_visited", self.GetNormalColour())

    def SetHoverColour(self, colour):
        self._hover = Colour(colour)

    def GetHoverColour(self):
        return getattr(self, "_hover", self.GetNormalColour())

    def GetURL(self):
        return self._url

    def SetURL(self, u):
        self._url = u


class Notebook(Window):
    def _wx_build(self, kw):
        self.el.classList.add("wx-book")
        self._tabs = _el("div", "wx-tabs")
        self.el.appendChild(self._tabs)
        self._pages = []
        self._sel = -1

    def _wx_adopt(self, child):
        child.el.classList.add("wx-page")
        child.el.hidden = True
        self.el.appendChild(child.el)

    def AddPage(self, page, text="", select=False, imageId=-1):
        b = _el("button")
        b.type = "button"
        b.textContent = str(text)
        idx = len(self._pages)
        _listen(b, "click", lambda e=None: self._wx_choose(idx, True))
        self._tabs.appendChild(b)
        self._pages.append((page, b, str(text)))
        if page._wx_parent is not self:
            page.Reparent(self)
        if select or self._sel < 0:
            self._wx_choose(idx, False)
        return True

    def InsertPage(self, index, page, text="", select=False, imageId=-1):
        return self.AddPage(page, text, select)

    def _wx_choose(self, idx, user):
        old = self._sel
        self._sel = idx
        for i, (p, b, _t) in enumerate(self._pages):
            p.el.hidden = i != idx
            b.classList.toggle("on", i == idx)
        if user and old != idx:
            ev = Event(self, EVT_NOTEBOOK_PAGE_CHANGED)          # noqa: F821
            ev._int = idx
            self._wx_fire(EVT_NOTEBOOK_PAGE_CHANGED, ev)          # noqa: F821
            t = self._wx_top()
            if t is not None:
                t._wx_refit()

    def GetSelection(self):
        return self._sel

    def SetSelection(self, n):
        old = self._sel
        self._wx_choose(n, False)
        return old

    ChangeSelection = SetSelection

    def GetPageCount(self):
        return len(self._pages)

    def GetPage(self, n):
        return self._pages[n][0]

    def GetCurrentPage(self):
        return self._pages[self._sel][0] if 0 <= self._sel < len(self._pages) else None

    def GetPageText(self, n):
        return self._pages[n][2]

    def SetPageText(self, n, text):
        self._pages[n][1].textContent = str(text)
        return True

    def DeleteAllPages(self):
        for p, b, _t in self._pages:
            b.remove()
            p.Destroy()
        self._pages, self._sel = [], -1
        return True

    def RemovePage(self, n):
        p, b, _t = self._pages.pop(n)
        b.remove()
        p.el.hidden = True
        return True

    DeletePage = RemovePage
    AssignImageList = SetImageList = SetPageImage = SetPadding = lambda self, *a: None


Choicebook = Listbook = Simplebook = Treebook = Toolbook = Notebook


class CollapsiblePane(Window):
    _TAG, _CLS = "details", ""

    def __init__(self, parent=None, id=ID_ANY, label="", pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        self._plabel = label if isinstance(label, str) else ""
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)

    def _wx_build(self, kw):
        s = _el("summary")
        s.textContent = self._plabel
        self.el.appendChild(s)
        self._pane = Panel(self)
        _listen(self.el, "toggle", lambda e=None: self._wx_fire(EVT_COLLAPSIBLEPANE_CHANGED, Event(self, EVT_COLLAPSIBLEPANE_CHANGED)))          # noqa: F821

    def GetPane(self):
        return self._pane

    def Collapse(self, collapse=True):
        self.el.open = not collapse

    def Expand(self):
        self.el.open = True

    def IsCollapsed(self):
        return not bool(getattr(self.el, "open", False))

    IsExpanded = lambda self: not self.IsCollapsed()


class ListCtrl(Window):
    """Report view: a table with a header; rows can be selected."""
    _CLS = "wx-table"

    def _wx_build(self, kw):
        self._table = _el("table")
        self._head = _el("tr")
        self._table.appendChild(self._head)
        self.el.appendChild(self._table)
        self._cols = []
        self._rows = []          # each: {"cells": [...], "tr": el, "data": int, "sel": bool, "tds": [...]}

    def InsertColumn(self, col, heading="", format=LIST_FORMAT_LEFT, width=-1):
        text = heading if isinstance(heading, str) else getattr(heading, "_text", "")
        if not isinstance(heading, str) and getattr(heading, "_width", -1) > 0:
            width = heading._width
        th = _el("th")
        th.textContent = text
        self._head.appendChild(th)
        self._cols.append(text)
        _listen(th, "click", lambda e=None: self._wx_col_click(th))
        self.__dict__.setdefault("_col_els", []).append(th)
        self.__dict__.setdefault("_col_widths", []).append(-1)
        if self._wx_style & LC_NO_HEADER:
            self._head.style.display = "none"          # the columns stay (they carry the widths), the heading row is not shown
        self.SetColumnWidth(len(self._cols) - 1, width)
        return len(self._cols) - 1

    def SetColumnWidth(self, col, width):
        widths = self.__dict__.setdefault("_col_widths", [])
        if not 0 <= col < len(widths):
            return False
        widths[col] = int(width)
        css = f"{int(width)}px" if width and width > 0 else ""
        self.__dict__["_col_els"][col].style.width = css
        for row in self._rows:
            if col < len(row["tds"]):
                row["tds"][col].style.width = css
        return True

    def GetColumnWidth(self, col):
        widths = self.__dict__.get("_col_widths", [])
        if not 0 <= col < len(widths):
            return 0
        if widths[col] > 0:
            return widths[col]
        if _DOM:
            try:
                w = int(self.__dict__["_col_els"][col].getBoundingClientRect().width)
                if w <= 0 and self._rows and col < len(self._rows[0]["tds"]):
                    w = int(self._rows[0]["tds"][col].getBoundingClientRect().width)
                if w > 0:
                    return w
            except Exception:
                pass
        return 80

    def GetColumn(self, col):
        if not 0 <= col < len(self._cols):
            return None
        item = ListItem(self._cols[col], col)
        item._width = self.GetColumnWidth(col)
        return item

    def SetColumn(self, col, item):
        if not 0 <= col < len(self._cols):
            return False
        text = item if isinstance(item, str) else item.GetText()
        self._cols[col] = text
        self.__dict__["_col_els"][col].textContent = text
        if not isinstance(item, str) and getattr(item, "_width", -1) > 0:
            self.SetColumnWidth(col, item._width)
        return True

    def SetTextColour(self, colour):
        return self.SetForegroundColour(colour)

    GetTextColour = lambda self: self.GetForegroundColour()

    AppendColumn = lambda self, heading="", format=LIST_FORMAT_LEFT, width=-1: self.InsertColumn(len(self._cols), heading, format, width)

    def GetColumnCount(self):
        return len(self._cols)

    def _wx_row(self, index, texts):
        tr = _el("tr")
        row = {"cells": [str(t) for t in texts] + [""] * (len(self._cols) - len(texts)), "tr": tr, "data": 0, "sel": False, "tds": []}
        for t in row["cells"]:
            td = _el("td")
            td.textContent = t
            tr.appendChild(td)
            row["tds"].append(td)
        _listen(tr, "click", lambda e=None: self._wx_click(row))
        _listen(tr, "dblclick", lambda e=None: self._wx_activate(row))
        index = max(0, min(index, len(self._rows)))
        after = self._rows[index]["tr"] if index < len(self._rows) else None
        self._rows.insert(index, row)
        if after is not None:
            self._table.insertBefore(tr, after)          # a row put in the middle is shown in the middle
        else:
            self._table.appendChild(tr)
        self._wx_box(row)
        return index

    def _wx_click(self, row):
        if self._wx_style & LC_SINGLE_SEL or True:
            for r in self._rows:
                if r is not row and r["sel"]:
                    r["sel"] = False
                    r["tr"].classList.remove("sel")
        row["sel"] = True
        row["tr"].classList.add("sel")
        ev = Event(self, EVT_LIST_ITEM_SELECTED)          # noqa: F821
        ev._int = self._rows.index(row)
        self._wx_fire(EVT_LIST_ITEM_SELECTED, ev)          # noqa: F821

    def _wx_col_click(self, th):
        """A click on a column's heading (EVT_LIST_COL_CLICK): lists sort themselves from it."""
        els = self.__dict__.get("_col_els", [])
        if th in els:
            ev = Event(self, EVT_LIST_COL_CLICK)          # noqa: F821
            ev._column = ev._int = els.index(th)
            self._wx_fire(EVT_LIST_COL_CLICK, ev)          # noqa: F821

    def _wx_activate(self, row):
        ev = Event(self, EVT_LIST_ITEM_ACTIVATED)          # noqa: F821
        ev._int = self._rows.index(row)
        self._wx_fire(EVT_LIST_ITEM_ACTIVATED, ev)          # noqa: F821

    def InsertItem(self, index, label="", *_):
        if not isinstance(index, int):
            index, label = len(self._rows), getattr(index, "_text", "")
        return self._wx_row(index, [label])

    InsertStringItem = InsertItem

    def Append(self, entry):
        return self._wx_row(len(self._rows), list(entry))

    def SetItem(self, index, col=0, label="", *_):
        if 0 <= index < len(self._rows) and 0 <= col < len(self._rows[index]["cells"]):
            row = self._rows[index]
            row["cells"][col] = str(label)
            row["tds"][col].textContent = str(label)
            if col == 0 and row.get("box") is not None:          # the text replaced the cell: its check box goes back in front
                td = row["tds"][0]
                td.insertBefore(row["box"], td.firstChild) if _DOM else td.appendChild(row["box"])
        return True

    SetStringItem = SetItem

    def GetItemText(self, index, col=0):
        return self._rows[index]["cells"][col] if 0 <= index < len(self._rows) and col < len(self._rows[index]["cells"]) else ""

    def GetItem(self, index, col=0):
        return ListItem(self.GetItemText(index, col), index)

    def SetItemText(self, index, text):
        self.SetItem(index, 0, text)

    def GetItemCount(self):
        return len(self._rows)

    def SetItemData(self, index, data):
        self._rows[index]["data"] = data
        return True

    def GetItemData(self, index):
        return self._rows[index]["data"]

    def DeleteAllItems(self):
        for r in self._rows:
            r["tr"].remove()
        self._rows = []
        return True

    def DeleteItem(self, index):
        self._rows.pop(index)["tr"].remove()
        return True

    def ClearAll(self):
        self.DeleteAllItems()
        self._head.replaceChildren()
        self._cols = []

    def GetTopItem(self):
        """The first row in view: the list shows its rows from the top, so the first one (none in an empty list)."""
        return 0 if self.GetItemCount() else -1

    def GetCountPerPage(self):
        return max(1, self.GetItemCount())

    def GetFirstSelected(self):
        return self.GetNextSelected(-1)

    def GetNextSelected(self, after):
        for i in range(after + 1, len(self._rows)):
            if self._rows[i]["sel"]:
                return i
        return -1

    def GetNextItem(self, item, geometry=LIST_NEXT_ALL, state=0):
        return self.GetNextSelected(item) if state & LIST_STATE_SELECTED else (item + 1 if item + 1 < len(self._rows) else -1)

    def GetSelectedItemCount(self):
        return len([r for r in self._rows if r["sel"]])

    def IsSelected(self, index):
        return self._rows[index]["sel"]

    def Select(self, index, on=True):
        if 0 <= index < len(self._rows):
            row = self._rows[index]
            was = row["sel"]
            if on and self._wx_style & LC_SINGLE_SEL:
                for r in self._rows:
                    if r is not row and r["sel"]:
                        r["sel"] = False
                        r["tr"].classList.remove("sel")
            row["sel"] = bool(on)
            row["tr"].classList.toggle("sel", bool(on))
            if bool(on) != bool(was):          # wxWidgets tells the handlers about a selection made in code too
                kind = EVT_LIST_ITEM_SELECTED if on else EVT_LIST_ITEM_DESELECTED          # noqa: F821
                ev = Event(self, kind)
                ev._int = index
                self._wx_fire(kind, ev)

    def SetItemState(self, index, state, mask):
        if mask & LIST_STATE_SELECTED:
            self.Select(index, bool(state & LIST_STATE_SELECTED))

    def GetItemState(self, index, mask):
        return LIST_STATE_SELECTED if self._rows[index]["sel"] else 0

    def Focus(self, index):
        pass

    def GetFocusedItem(self):
        return self.GetFirstSelected()

    EnsureVisible = SetImageList = AssignImageList = SetItemFont = SortItems = lambda self, *a, **k: None

    def SetItemTextColour(self, index, colour):
        if 0 <= index < len(self._rows):
            self._rows[index]["tr"].style.color = Colour(colour)._css() if colour is not None else ""

    def SetItemBackgroundColour(self, index, colour):
        if 0 <= index < len(self._rows):
            self._rows[index]["tr"].style.background = Colour(colour)._css() if colour is not None else ""

    # -- check boxes (wxListCtrl::EnableCheckBoxes): one at the start of each row
    def EnableCheckBoxes(self, enable=True):
        self.__dict__["_checks"] = bool(enable)
        for row in self._rows:
            self._wx_box(row)
        return True

    def HasCheckBoxes(self):
        return bool(self.__dict__.get("_checks"))

    def _wx_box(self, row):
        on, box = self.__dict__.get("_checks"), row.get("box")
        if on and box is None and row["tds"]:
            box = _el("input")
            box.type = "checkbox"
            box.className = "wx-tree-chk"
            box.checked = bool(row.get("checked"))
            _listen(box, "click", lambda e=None: self._wx_tick(row, bool(box.checked), e))
            td = row["tds"][0]
            td.insertBefore(box, td.firstChild) if _DOM else td.appendChild(box)
            row["box"] = box
        elif not on and box is not None:
            box.remove()
            row["box"] = None

    def _wx_tick(self, row, on, dom_event=None):
        if dom_event is not None and hasattr(dom_event, "stopPropagation"):
            dom_event.stopPropagation()              # ticking a row does not select it
        if bool(row.get("checked")) == bool(on):
            return
        row["checked"] = bool(on)
        if row.get("box") is not None:
            row["box"].checked = bool(on)
        kind = EVT_LIST_ITEM_CHECKED if on else EVT_LIST_ITEM_UNCHECKED          # noqa: F821
        ev = Event(self, kind)
        ev._int = self._rows.index(row)
        self._wx_fire(kind, ev)

    def CheckItem(self, index, check=True):
        if self.__dict__.get("_checks") and 0 <= index < len(self._rows):
            self._wx_tick(self._rows[index], bool(check))

    def IsItemChecked(self, index):
        return bool(self.__dict__.get("_checks")) and 0 <= index < len(self._rows) and bool(self._rows[index].get("checked"))


ListView = ListCtrl


LIST_MASK_STATE, LIST_MASK_TEXT, LIST_MASK_IMAGE, LIST_MASK_DATA, LIST_MASK_WIDTH, LIST_MASK_FORMAT = 1, 2, 4, 8, 64, 128


class ListItem:
    def __init__(self, text="", index=0):
        self._text, self._index, self._width, self._align = text, index, -1, 0

    def GetWidth(self):
        return self._width

    def SetWidth(self, w):
        self._width = int(w)

    def GetAlign(self):
        return self._align

    def SetAlign(self, a):
        self._align = a

    def GetText(self):
        return self._text

    def SetText(self, t):
        self._text = t

    def GetId(self):
        return self._index

    SetId = lambda self, i: setattr(self, "_index", i)
    SetColumn = SetImage = SetData = lambda self, *a: None

    def GetMask(self):
        return self.__dict__.get("_mask", 0)

    def SetMask(self, m):
        self._mask = int(m)

    GetColumn = lambda self: self.__dict__.get("_column", 0)
    GetImage = lambda self: -1
    GetData = lambda self: 0


class ToolTip:
    def __init__(self, text=""):
        self._text = str(text)

    def GetTip(self):
        return self._text

    SetTip = lambda self, t: setattr(self, "_text", str(t))
    Enable = SetDelay = SetAutoPop = SetReshow = SetMaxWidth = staticmethod(lambda *a: None)


class _Picker(Window):
    """FilePickerCtrl / DirPickerCtrl: a text field holding the path."""
    _CLS = "wx-sizer wx-h"
    _DIR = False

    def __init__(self, parent=None, id=ID_ANY, path="", message="", wildcard="*.*", pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        self._wild = kw.get("wildcard", wildcard)
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)
        self.SetPath(kw.get("path", path) or self._wx_save_default())

    def _wx_save_default(self):
        """A "save as" picker starts on a name in the project folder: there is no file dialog to browse a computer's
        folders here, and what a plugin writes in the project folder is handed over as a download."""
        if self._DIR or not (self._wx_style & FLP_SAVE):
            return ""
        import os
        import re
        ext = re.search(r"\*(\.[A-Za-z0-9_]+)", str(self._wild or ""))
        try:
            import kicad_web
            return os.path.join(kicad_web.PROJECT_DIR, kicad_web._board_stem() + (ext.group(1) if ext else ""))
        except Exception:
            return ""

    def _wx_save_place(self, p):
        """The name picked to save to stands for a file a person chose in a save dialog.  Some plugins only accept a
        path that is already there, and here nothing is, so an empty file holds the place (it is not handed over
        unless the plugin goes on to write it)."""
        import os
        if not p or self._DIR or not (self._wx_style & FLP_SAVE) or os.path.exists(p):
            return
        try:
            import kicad_web
            os.makedirs(os.path.dirname(os.path.abspath(p)), exist_ok=True)
            open(p, "wb").close()
            kicad_web._state.setdefault("placeholders", set()).add(os.path.abspath(p))
        except Exception:
            pass

    def _wx_build(self, kw):
        self._text = _el("input")
        self._text.type = "text"
        self._text.style.flex = "1 1 auto"
        self.el.appendChild(self._text)
        self.el.style.gap = "4px"
        if not self._DIR and not (self._wx_style & FLP_SAVE):
            b = _el("button")
            b.type = "button"
            b.textContent = "Browse…"
            self.el.appendChild(b)
            _listen(b, "click", self._wx_browse)
        _listen(self._text, "change", lambda e=None: self._wx_changed())

    def _wx_changed(self):
        ev = _binders["EVT_DIRPICKER_CHANGED" if self._DIR else "EVT_FILEPICKER_CHANGED"]
        self._wx_fire(ev, Event(self, ev))

    def _wx_browse(self, _e=None):
        d = FileDialog(self, "Choose a file", wildcard=self._wild, style=FD_OPEN)
        if d.ShowModal() == ID_OK:
            self.SetPath(d.GetPath())
            self._wx_changed()

    def GetPath(self):
        p = str(self._text.value)
        self._wx_save_place(p)
        return p

    def SetPath(self, p):
        self._text.value = str(p or "")

    SetInitialDirectory = lambda self, d: None
    GetTextCtrl = lambda self: None
    SetTextCtrlGrowable = SetPickerCtrlGrowable = SetTextCtrlProportion = SetPickerCtrlProportion = SetInternalMargin = lambda self, *a: None
    HasTextCtrl = IsTextCtrlGrowable = lambda self: True
    IsPickerCtrlGrowable = lambda self: False
    GetPickerCtrl = lambda self: None


class FilePickerCtrl(_Picker):
    pass


class DirPickerCtrl(_Picker):
    _DIR = True

    def __init__(self, parent=None, id=ID_ANY, path="", message="", pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        _Picker.__init__(self, parent, id, path, message, "", pos, size, style, *more, **kw)


class ColourPickerCtrl(Window):
    _TAG, _CLS = "input", ""

    def __init__(self, parent=None, id=ID_ANY, colour=None, pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)
        self.SetColour(kw.get("colour", colour) or BLACK)

    def _wx_build(self, kw):
        self.el.type = "color"
        _listen(self.el, "change", lambda e=None: self._wx_fire(EVT_COLOURPICKER_CHANGED, Event(self, EVT_COLOURPICKER_CHANGED)))          # noqa: F821

    def GetColour(self):
        return Colour(str(self.el.value) or "#000000")

    def SetColour(self, c):
        self.el.value = Colour(c).GetAsString()


class _StubMeta(type):
    def __getattr__(cls, name):
        if name.startswith("_"):
            raise AttributeError(name)
        if name in ("New", "Create", "Get"):
            return lambda *a, **k: cls(*a, **k)
        return _Zero(0)


class _Stub(Window, metaclass=_StubMeta):
    """A widget this module has no web form for.  It takes its place in the layout and says what it stands for."""
    _CLS = "wx-stub"

    def __init__(self, *a, **kw):
        parent = a[0] if a and isinstance(a[0], Window) else kw.get("parent")
        Window.__init__(self, parent)
        self.el.textContent = f"{type(self).__name__} is not available in the web editor"

    def __iter__(self):
        return iter(())


# ----------------------------------------------------------------------------- sizers

class SizerItem:
    def __init__(self, sizer, thing, el, proportion, flag, border):
        self._wx_sizer, self._thing, self._el, self._prop, self._flag, self._border = sizer, thing, el, proportion, flag, border

    def GetWindow(self):
        return self._thing if isinstance(self._thing, Window) else None

    def GetSizer(self):
        return self._thing if isinstance(self._thing, Sizer) else None

    def IsWindow(self):
        return isinstance(self._thing, Window)

    def IsSizer(self):
        return isinstance(self._thing, Sizer)

    def IsSpacer(self):
        return self._thing is None

    def Show(self, show=True):
        self._el.hidden = not show

    def IsShown(self):
        return not bool(self._el.hidden)

    def GetProportion(self):
        return self._prop

    def SetProportion(self, p):
        self._prop = p
        self._el.style.flex = f"{p} {1 if p else 0} {'0%' if p else 'auto'}"

    GetFlag = lambda self: self._flag
    GetBorder = lambda self: self._border
    Proportion = property(lambda self: self._prop, lambda self, p: self.SetProportion(p))
    Flag = property(lambda self: self._flag)
    Border = property(lambda self: self._border)
    Window = property(lambda self: self.GetWindow())
    Sizer = property(lambda self: self.GetSizer())
    SetFlag = SetBorder = SetMinSize = SetInitSize = SetUserData = AssignSpacer = lambda self, *a: None
    GetSize = GetMinSize = lambda self: Size(0, 0)
    GetRect = lambda self: Rect()


class SizerFlags:
    def __init__(self, proportion=0):
        self._prop, self._flag, self._border = proportion, 0, 0

    def Proportion(self, p):
        self._prop = p
        return self

    def Expand(self):
        self._flag |= EXPAND
        return self

    def Border(self, direction=ALL, size=5):
        self._flag |= direction
        self._border = size
        return self

    DoubleBorder = lambda self, d=ALL: self.Border(d, 10)
    TripleBorder = lambda self, d=ALL: self.Border(d, 15)
    HorzBorder = lambda self: self.Border(LEFT | RIGHT)
    DoubleHorzBorder = lambda self: self.Border(LEFT | RIGHT, 10)

    def Align(self, a):
        self._flag |= a
        return self

    Center = Centre = lambda self: self.Align(ALIGN_CENTER)
    CenterVertical = CentreVertical = lambda self: self.Align(ALIGN_CENTER_VERTICAL)
    CenterHorizontal = CentreHorizontal = lambda self: self.Align(ALIGN_CENTER_HORIZONTAL)
    Left = lambda self: self
    Top = lambda self: self
    Right = lambda self: self.Align(ALIGN_RIGHT)
    Bottom = lambda self: self.Align(ALIGN_BOTTOM)
    Shaped = FixedMinSize = ReserveSpaceEvenIfHidden = lambda self: self
    GetDefaultBorder = staticmethod(lambda: 5)
    DisableConsistencyChecks = staticmethod(lambda: None)


class Sizer:
    _CLS = "wx-sizer wx-v"

    def __init__(self):
        self.el = _el("div", self._CLS)
        self._wx_items = []
        self._wx_owner = None

    def _wx_vertical(self):
        return True

    def _wx_place(self, item):
        self.el.appendChild(item._el)

    def _wx_style_item(self, item):
        el, flag, border, prop = item._el, item._flag, item._border, item._prop
        st = el.style
        if prop:
            st.flex = f"{prop} 1 0%"
            if self._wx_vertical():
                st.minHeight = st.minHeight or "0"
            else:
                st.minWidth = st.minWidth or "0"
        elif not isinstance(self, GridSizer):
            st.flex = "0 0 auto"
        if border:
            for bit, side in ((LEFT, "Left"), (RIGHT, "Right"), (TOP, "Top"), (BOTTOM, "Bottom")):
                if flag & bit:
                    setattr(st, "margin" + side, _px(border))
        grid = isinstance(self, GridSizer)
        if flag & EXPAND:
            st.alignSelf = "stretch"
            if grid:
                st.justifySelf = "stretch"
        else:
            cross_c = ALIGN_CENTER_HORIZONTAL if self._wx_vertical() else ALIGN_CENTER_VERTICAL
            cross_e = ALIGN_RIGHT if self._wx_vertical() else ALIGN_BOTTOM
            if grid:
                st.alignSelf = "center" if flag & ALIGN_CENTER_VERTICAL else ("end" if flag & ALIGN_BOTTOM else "")
                st.justifySelf = "center" if flag & ALIGN_CENTER_HORIZONTAL else ("end" if flag & ALIGN_RIGHT else "start")
            elif flag & cross_c:
                st.alignSelf = "center"
            elif flag & cross_e:
                st.alignSelf = "flex-end"
            elif self._wx_vertical():
                st.alignSelf = "flex-start"
            main_e = ALIGN_BOTTOM if self._wx_vertical() else ALIGN_RIGHT
            if not grid and flag & main_e:
                setattr(st, "marginTop" if self._wx_vertical() else "marginLeft", "auto")

    def Add(self, *a, **kw):
        return self._wx_add(None, a, kw)

    def Insert(self, index, *a, **kw):
        return self._wx_add(index, a, kw)

    def Prepend(self, *a, **kw):
        return self._wx_add(0, a, kw)

    def _wx_add(self, index, a, kw):
        a = list(a)
        thing = a.pop(0) if a else kw.pop("window", kw.pop("sizer", None))
        if isinstance(thing, int) and a and isinstance(a[0], int) and not isinstance(a[0], bool) and len(a) >= 1 and not kw.get("_plain"):
            # Add(width, height, proportion, flag, border): a spacer
            thing = (thing, a.pop(0))
        prop, flag, border = 0, 0, 0
        if a and isinstance(a[0], SizerFlags):
            prop, flag, border = a[0]._prop, a[0]._flag, a[0]._border
        elif isinstance(kw.get("flags"), SizerFlags):
            f = kw["flags"]
            prop, flag, border = f._prop, f._flag, f._border
        else:
            vals = a + [None] * 3
            prop = kw.get("proportion", vals[0] if vals[0] is not None else 0)
            flag = kw.get("flag", vals[1] if vals[1] is not None else 0)
            border = kw.get("border", vals[2] if vals[2] is not None else 0)
        if isinstance(thing, Window):
            el = thing.el
            thing._wx_in_sizer = self
            if isinstance(thing, ComboBox):
                item = SizerItem(self, thing, el, prop, flag, border)
                self._wx_finish(item, index)
                thing._wx_adopt_list()
                return item
        elif isinstance(thing, Sizer):
            el = thing.el
            thing._wx_owner = self._wx_owner
        else:
            el = _el("div")
            w, h = (tuple(thing) + (0, 0))[:2] if isinstance(thing, (tuple, list, Size)) else (0, 0)
            el.style.width, el.style.height = _px(w), _px(h)
            el.style.flex = "0 0 auto"
            thing = None
        item = SizerItem(self, thing, el, prop, flag, border)
        self._wx_finish(item, index)
        return item

    def _wx_finish(self, item, index):
        self._wx_style_item(item)
        if index is None or index >= len(self._wx_items):
            self._wx_items.append(item)
            self._wx_place(item)
        else:
            self._wx_items.insert(index, item)
            self.el.insertBefore(item._el, self._wx_items[index + 1]._el)

    def AddSpacer(self, size):
        return self._wx_add(None, ((size, size),), {})

    def AddStretchSpacer(self, prop=1):
        return self._wx_add(None, ((0, 0), prop), {})

    def AddMany(self, items):
        for it in items:
            if isinstance(it, (tuple, list)):
                self.Add(*it)
            else:
                self.Add(it)

    def _wx_find(self, thing):
        if isinstance(thing, int):
            return self._wx_items[thing] if 0 <= thing < len(self._wx_items) else None
        for it in self._wx_items:
            if it._thing is thing:
                return it
        return None

    def GetItem(self, thing, recursive=False):
        it = self._wx_find(thing)
        if it is None and recursive:
            for sub in self._wx_items:
                if isinstance(sub._thing, Sizer):
                    it = sub._thing.GetItem(thing, True)
                    if it is not None:
                        break
        return it

    def Show(self, thing, show=True, recursive=False):
        if isinstance(thing, bool):
            self.el.hidden = not thing
            return True
        it = self.GetItem(thing, recursive)
        if it is None:
            return False
        it.Show(show)
        if isinstance(thing, Window):
            thing._wx_shown = bool(show)
        return True

    def Hide(self, thing, recursive=False):
        return self.Show(thing, False, recursive)

    def ShowItems(self, show):
        for it in self._wx_items:
            it.Show(show)

    def IsShown(self, thing):
        it = self.GetItem(thing)
        return it.IsShown() if it is not None else False

    def Detach(self, thing):
        it = self._wx_find(thing)
        if it is None:
            return False
        self._wx_items.remove(it)
        try:
            it._el.remove()
        except Exception:
            pass
        return True

    Remove = Detach

    def Replace(self, old, new, recursive=False):
        it = self._wx_find(old)
        if it is None:
            return False
        idx = self._wx_items.index(it)
        self.Detach(old)
        self.Insert(idx, new, it._prop, it._flag, it._border)
        return True

    def Clear(self, delete_windows=False):
        for it in list(self._wx_items):
            if delete_windows and isinstance(it._thing, Window):
                it._thing.Destroy()
            try:
                it._el.remove()
            except Exception:
                pass
        self._wx_items = []

    DeleteWindows = lambda self: self.Clear(True)

    def GetChildren(self):
        return list(self._wx_items)

    def GetItemCount(self):
        return len(self._wx_items)

    def IsEmpty(self):
        return not self._wx_items

    def GetContainingWindow(self):
        return self._wx_owner

    def Fit(self, window=None):
        if window is not None:
            t = window._wx_top()
            if t is not None:
                t._wx_refit()
        return Size(0, 0)

    def Layout(self):
        pass

    def SetSizeHints(self, window=None):
        pass

    FitInside = SetMinSize = SetItemMinSize = SetDimension = RecalcSizes = SetVirtualSizeHints = lambda self, *a, **k: None
    GetSize = GetMinSize = CalcMin = ComputeFittingClientSize = ComputeFittingWindowSize = lambda self, *a: Size(0, 0)
    GetPosition = lambda self: Point(0, 0)


class BoxSizer(Sizer):
    def __init__(self, orient=HORIZONTAL):
        self._orient = orient
        self._CLS = "wx-sizer " + ("wx-v" if orient == VERTICAL else "wx-h")
        Sizer.__init__(self)

    def _wx_vertical(self):
        return self._orient == VERTICAL

    def GetOrientation(self):
        return self._orient

    def SetOrientation(self, o):
        self._orient = o
        self.el.className = "wx-sizer " + ("wx-v" if o == VERTICAL else "wx-h")


class WrapSizer(BoxSizer):
    def __init__(self, orient=HORIZONTAL, flags=0):
        BoxSizer.__init__(self, orient)
        self.el.style.flexWrap = "wrap"


class StaticBoxSizer(BoxSizer):
    def __init__(self, box_or_orient=VERTICAL, parent_or_orient=None, label="", **kw):
        if "box" in kw:
            box_or_orient, parent_or_orient = kw["box"], kw.get("orient", parent_or_orient)
        elif "orient" in kw:
            box_or_orient, parent_or_orient = kw["orient"], kw.get("parent", parent_or_orient if not isinstance(box_or_orient, Window) else box_or_orient)
        elif "parent" in kw:
            parent_or_orient = kw["parent"]
        label = kw.get("label", label)
        if isinstance(box_or_orient, StaticBox):
            self._wx_box, orient = box_or_orient, (parent_or_orient if isinstance(parent_or_orient, int) else HORIZONTAL)
        else:
            orient = box_or_orient
            self._wx_box = StaticBox(parent_or_orient if isinstance(parent_or_orient, Window) else None, ID_ANY, label)
        BoxSizer.__init__(self, orient)
        inner = self.el
        inner.style.flex = "1 1 auto"
        self.el = self._wx_box.el
        self._inner = inner
        self.el.appendChild(inner)

    def _wx_place(self, item):
        self._inner.appendChild(item._el)

    def _wx_finish(self, item, index):
        self._wx_style_item(item)
        self._wx_items.append(item)
        self._wx_place(item)

    def GetStaticBox(self):
        return self._wx_box


class GridSizer(Sizer):
    _CLS = "wx-sizer wx-grid"

    def __init__(self, *a, **kw):
        Sizer.__init__(self)
        self.el.style.display = "grid"
        nums = [x for x in a if isinstance(x, int)]
        rows, cols, vgap, hgap = 0, 1, 0, 0
        if len(nums) == 1:
            cols = nums[0]
        elif len(nums) == 2:
            rows, cols = nums
        elif len(nums) == 3:
            cols, vgap, hgap = nums
        elif len(nums) >= 4:
            rows, cols, vgap, hgap = nums[:4]
        gaps = [x for x in a if isinstance(x, (tuple, list, Size))]
        if gaps:
            hgap, vgap = gaps[0][0], gaps[0][1]
        self._rows, self._cols = kw.get("rows", rows), kw.get("cols", cols)
        self._vgap, self._hgap = kw.get("vgap", vgap), kw.get("hgap", hgap)
        self._grow_cols, self._grow_rows = {}, {}
        self._even = type(self) is GridSizer
        self._wx_template()

    def _wx_vertical(self):
        return False

    def _wx_ncols(self):
        if self._cols:
            return self._cols
        n = len(self._wx_items)
        return max(1, -(-n // self._rows)) if self._rows else 1

    def _wx_template(self):
        n = self._wx_ncols()
        if self._even:
            cols = f"repeat({n}, minmax(0, 1fr))"
        else:
            cols = " ".join(f"minmax(max-content, {self._grow_cols[i] or 1}fr)" if i in self._grow_cols else "max-content" for i in range(n))
        self.el.style.gridTemplateColumns = cols
        self.el.style.gap = f"{max(self._vgap, 0)}px {max(self._hgap, 0)}px"
        if self._grow_rows:
            last = max(self._grow_rows) + 1
            self.el.style.gridTemplateRows = " ".join("minmax(max-content, 1fr)" if i in self._grow_rows else "max-content" for i in range(last))

    def _wx_finish(self, item, index):
        Sizer._wx_finish(self, item, index)
        if not self._cols:
            self._wx_template()

    def SetCols(self, n):
        self._cols = n
        self._wx_template()

    def SetRows(self, n):
        self._rows = n
        self._wx_template()

    def GetCols(self):
        return self._wx_ncols()

    def GetRows(self):
        return self._rows or -(-len(self._wx_items) // self._wx_ncols())

    def SetHGap(self, g):
        self._hgap = g
        self._wx_template()

    def SetVGap(self, g):
        self._vgap = g
        self._wx_template()

    GetHGap = lambda self: self._hgap
    GetVGap = lambda self: self._vgap
    GetEffectiveColsCount = GetCols
    GetEffectiveRowsCount = GetRows


FLEX_GROWMODE_NONE, FLEX_GROWMODE_SPECIFIED, FLEX_GROWMODE_ALL = 0, 1, 2


class FlexGridSizer(GridSizer):
    def _wx_tracks(self, cols):
        """Measured column widths (or row heights) of the laid-out grid, in pixels."""
        n = (self.GetCols() if cols else self.GetRows()) or 1
        if _DOM:
            try:
                st = _js.getComputedStyle(self.el)
                parts = str(st.gridTemplateColumns if cols else st.gridTemplateRows).split()
                vals = [int(round(float(x[:-2]))) for x in parts if x.endswith("px")]
                if vals:
                    return vals
            except Exception:
                pass
        return [120] * int(n)

    def GetColWidths(self):
        return self._wx_tracks(True)

    def GetRowHeights(self):
        return self._wx_tracks(False)

    def AddGrowableCol(self, idx, proportion=0):
        self._grow_cols[idx] = proportion
        self._wx_template()

    def AddGrowableRow(self, idx, proportion=0):
        self._grow_rows[idx] = proportion
        self._wx_template()

    def RemoveGrowableCol(self, idx):
        self._grow_cols.pop(idx, None)
        self._wx_template()

    def RemoveGrowableRow(self, idx):
        self._grow_rows.pop(idx, None)
        self._wx_template()

    def IsColGrowable(self, idx):
        return idx in self._grow_cols

    def IsRowGrowable(self, idx):
        return idx in self._grow_rows

    SetFlexibleDirection = SetNonFlexibleGrowMode = lambda self, *a: None
    GetFlexibleDirection = lambda self: BOTH


class GBPosition(tuple):
    def __new__(cls, row=0, col=0):
        return tuple.__new__(cls, (row, col))

    GetRow = lambda self: self[0]
    GetCol = lambda self: self[1]


class GBSpan(GBPosition):
    def __new__(cls, rowspan=1, colspan=1):
        return tuple.__new__(cls, (rowspan, colspan))

    GetRowspan = lambda self: self[0]
    GetColspan = lambda self: self[1]


class GridBagSizer(FlexGridSizer):
    def __init__(self, vgap=0, hgap=0):
        self._max_col = 0
        FlexGridSizer.__init__(self, 0, 0, vgap, hgap)

    def _wx_ncols(self):
        return max(1, self._max_col)

    def Add(self, thing, pos=(0, 0), span=(1, 1), flag=0, border=0, userData=None, **kw):
        pos = kw.get("pos", pos)
        span = kw.get("span", span)
        item = self._wx_add(None, (thing, 0, kw.get("flag", flag), kw.get("border", border)), {"_plain": True})
        r, c = int(pos[0]), int(pos[1])
        rs, cs = int(span[0]), int(span[1])
        item._el.style.gridRow = f"{r + 1} / span {max(1, rs)}"
        item._el.style.gridColumn = f"{c + 1} / span {max(1, cs)}"
        self._max_col = max(self._max_col, c + cs)
        self._wx_template()
        return item

    def SetEmptyCellSize(self, *_):
        pass

    GetItemPosition = lambda self, *_: GBPosition(0, 0)
    SetItemPosition = SetItemSpan = lambda self, *a: True


class StdDialogButtonSizer(BoxSizer):
    def __init__(self):
        BoxSizer.__init__(self, HORIZONTAL)
        self.el.className = "wx-stdbtns"
        self._buttons = []

    def AddButton(self, button):
        self._buttons.append(button)
        self.el.appendChild(button.el)
        if button.GetId() in (ID_OK, ID_YES, ID_SAVE) and _DOM:
            button.el.classList.add("primary")

    def SetAffirmativeButton(self, b):
        self.AddButton(b)

    SetNegativeButton = SetCancelButton = SetAffirmativeButton

    def Realize(self):
        order = {ID_HELP: 0, ID_APPLY: 1, ID_NO: 2, ID_CANCEL: 3, ID_CLOSE: 3, ID_OK: 4, ID_YES: 4, ID_SAVE: 4}
        for b in sorted(self._buttons, key=lambda b: order.get(b.GetId(), 2)):
            self.el.appendChild(b.el)

    GetAffirmativeButton = lambda self: next((b for b in self._buttons if b.GetId() in (ID_OK, ID_YES, ID_SAVE)), None)
    GetCancelButton = lambda self: next((b for b in self._buttons if b.GetId() in (ID_CANCEL, ID_CLOSE)), None)
    GetApplyButton = lambda self: next((b for b in self._buttons if b.GetId() == ID_APPLY), None)


# ----------------------------------------------------------------------------- top-level windows

class TopLevelWindow(Window):
    _CLS = "wx-top"

    def __init__(self, parent=None, id=ID_ANY, title="", pos=DefaultPosition, size=DefaultSize, style=DEFAULT_DIALOG_STYLE, name="", *more, **kw):
        self._wx_title = title if isinstance(title, str) else ""
        self._wx_modal = False
        self._wx_return = ID_CANCEL
        self._resolve = None
        self._wx_default = None
        self._wx_want = None
        self._wx_visible = False
        Window.__init__(self, parent, id, pos, DefaultSize, style, name, **kw)
        self._wx_shown = False
        size = kw.get("size", size)
        if size is not None and tuple(size) != (-1, -1):
            self._wx_want = (int(size[0]), int(size[1]))
        if _DOM:
            _js.document.body.appendChild(self.el)
        _top_windows.append(self)

    def SetMinSize(self, size):
        pass

    def SetSize(self, *a):
        s = a[0] if len(a) == 1 else (a if len(a) == 2 else a[2:4])
        try:
            self._wx_want = (int(s[0]), int(s[1]))
        except Exception:
            pass
        self._wx_refit()

    SetClientSize = SetInitialSize = SetSize

    def SetSizerAndFit(self, sizer, *_):
        self.SetSizer(sizer)
        self._wx_want = None

    def Fit(self):
        self._wx_want = None
        self._wx_refit()

    def GetTitle(self):
        return self._wx_title

    def SetTitle(self, t):
        self._wx_title = str(t)
        if self._wx_visible:
            self._wx_present()

    def SetLabel(self, t):
        self.SetTitle(t)

    def GetLabel(self):
        return self._wx_title

    def _wx_present(self):
        """Have the editor show this window (a floating dialog around the plugin's frame)."""
        if _DOM:
            for w in _top_windows:
                w.el.classList.toggle("wx-shown", w is self)
            want = self._wx_want or (0, 0)
            _kc().show(self._wx_title, self.el, want[0], want[1], bool(self._wx_modal))

    def _wx_refit(self):
        if self._wx_visible:
            self._wx_present()

    def Show(self, show=True):
        if show and not self._wx_visible:
            self._wx_visible = self._wx_shown = True
            self._wx_present()
            self._wx_fire(EVT_SHOW, Event(self, EVT_SHOW))          # noqa: F821
        elif not show and self._wx_visible:
            self._wx_withdraw()
        return True

    def _wx_withdraw(self):
        self._wx_visible = self._wx_shown = False
        self.el.classList.remove("wx-shown")
        if _DOM:
            below = [w for w in _top_windows if w._wx_visible]
            if below:
                below[-1]._wx_present()
            else:
                _kc().hide()

    def Raise(self):
        if self._wx_visible:
            self._wx_present()

    def IsActive(self):
        return self._wx_visible

    def IsModal(self):
        return self._wx_modal

    def Close(self, force=False):
        ev = Event(self, EVT_CLOSE)          # noqa: F821
        if self._wx_fire(EVT_CLOSE, ev):          # noqa: F821
            if ev._vetoed:
                return False
            return True                     # a bound handler decides (it calls Destroy / EndModal itself)
        if self._wx_modal:
            self.EndModal(ID_CANCEL)
        else:
            self.Destroy()
        return True

    def _wx_closed_by_user(self):
        self.Close()

    def _wx_default_button(self, bid):
        pass

    def Destroy(self):
        if self._wx_modal:
            self.EndModal(self._wx_return)
        if self._wx_visible:
            self._wx_withdraw()
        if self in _top_windows:
            _top_windows.remove(self)
        return Window.Destroy(self)

    def Centre(self, *_, **_k):
        pass

    Center = CentreOnParent = CenterOnParent = CentreOnScreen = CenterOnScreen = Centre

    def SetIcon(self, icon):
        pass

    SetIcons = SetIcon

    def Maximize(self, *_):
        pass

    Iconize = Restore = RequestUserAttention = ShowFullScreen = SetTransparent = Maximize
    IsMaximized = IsIconized = IsFullScreen = lambda self: False
    GetDefaultItem = lambda self: self._wx_default

    def SetDefaultItem(self, b):
        self._wx_default = b

    def CreateStatusBar(self, *a, **k):
        self._wx_statusbar = StatusBar(self)
        return self._wx_statusbar

    def SetStatusText(self, text, *_):
        bar = getattr(self, "_wx_statusbar", None)
        if bar is not None:
            bar.SetStatusText(text)
        elif _bridge is not None:
            _bridge.status(str(text))

    def GetStatusBar(self):
        return getattr(self, "_wx_statusbar", None)

    def SetStatusBar(self, bar):
        self._wx_statusbar = bar

    def SetMenuBar(self, bar):
        self._wx_menubar = bar
        if isinstance(bar, MenuBar):
            bar._wx_parent = self
            self.el.insertBefore(bar.el, self.el.firstChild) if _DOM else self.el.appendChild(bar.el)

    def GetMenuBar(self):
        return getattr(self, "_wx_menubar", None)

    def CreateToolBar(self, *a, **k):
        self._wx_toolbar = ToolBar(self)
        return self._wx_toolbar

    def SetToolBar(self, bar):
        self._wx_toolbar = bar

    def GetToolBar(self):
        return getattr(self, "_wx_toolbar", None)


class StatusBar(Window):
    def __init__(self, parent=None, *a, **k):
        Window.__init__(self, parent)
        self.el.className = "muted"
        self.el.style.order = "99"
        self.el.style.paddingTop = "4px"

    def SetStatusText(self, text, *_):
        self.el.textContent = str(text)

    PushStatusText = SetStatusText
    SetFieldsCount = SetStatusWidths = SetStatusStyles = PopStatusText = lambda self, *a: None
    GetStatusText = lambda self, *_: str(self.el.textContent)


class Frame(TopLevelWindow):
    def __init__(self, parent=None, id=ID_ANY, title="", pos=DefaultPosition, size=DefaultSize, style=DEFAULT_FRAME_STYLE, name="frame", *more, **kw):
        TopLevelWindow.__init__(self, parent, id, title, pos, size, style, name, **kw)


MiniFrame = Frame


class Dialog(TopLevelWindow):
    def __init__(self, parent=None, id=ID_ANY, title="", pos=DefaultPosition, size=DefaultSize, style=DEFAULT_DIALOG_STYLE, name="dialog", *more, **kw):
        TopLevelWindow.__init__(self, parent, id, title, pos, size, style, name, **kw)
        self._affirmative, self._escape = ID_OK, ID_CANCEL

    def ShowModal(self):
        self._wx_modal = True
        self._wx_return = ID_CANCEL
        if not self._wx_fire(EVT_INIT_DIALOG, Event(self, EVT_INIT_DIALOG)):          # noqa: F821
            try:
                self.TransferDataToWindow()
            except Exception:
                pass
        if not _DOM:
            self._wx_visible = self._wx_shown = True
            self._wx_fire(EVT_SHOW, Event(self, EVT_SHOW))          # noqa: F821
            _run_later()                    # work the dialog starts by itself (wx.CallLater) is done before it is answered
            code = _headless_modal(self) if _headless_modal is not None else ID_CANCEL
            _run_later()
            if self._wx_modal:              # the stand-in answered; a dialog that ended itself keeps its own code
                self._wx_return = code
            self._wx_modal = self._wx_visible = self._wx_shown = False
            return self._wx_return
        self._wx_visible = self._wx_shown = True
        self._wx_present()
        self._wx_fire(EVT_SHOW, Event(self, EVT_SHOW))          # noqa: F821
        if self._wx_modal:
            _wait(_kc().modal(self._wx_id))
        self._wx_modal = False
        if self._wx_visible:
            self._wx_withdraw()
        return self._wx_return

    def EndModal(self, code):
        self._wx_return = code
        if self._wx_modal:
            self._wx_modal = False
            if _DOM:
                _kc().endModal(self._wx_id)

    def IsModal(self):
        return self._wx_modal

    def GetReturnCode(self):
        return self._wx_return

    def SetReturnCode(self, c):
        self._wx_return = c

    def SetAffirmativeId(self, i):
        self._affirmative = i

    def SetEscapeId(self, i):
        self._escape = i

    GetAffirmativeId = lambda self: self._affirmative
    GetEscapeId = lambda self: self._escape

    def _wx_default_button(self, bid):
        if bid in (ID_OK, ID_YES, ID_NO, ID_CANCEL, ID_CLOSE, ID_APPLY, ID_SAVE) or bid == self._affirmative:
            if bid in (ID_OK, ID_YES, ID_APPLY, ID_SAVE) or bid == self._affirmative:
                # accepting a dialog asks its validators first, and stays open when one says no
                if not (self.Validate() and self.TransferDataFromWindow()):
                    return
            if self._wx_modal:
                self.EndModal(bid)
            elif bid in (ID_CANCEL, ID_CLOSE, ID_OK):
                self.Close()

    def CreateButtonSizer(self, flags=OK | CANCEL):
        s = StdDialogButtonSizer()
        for bit, bid in ((OK, ID_OK), (YES, ID_YES), (NO, ID_NO), (APPLY, ID_APPLY), (CANCEL, ID_CANCEL), (CLOSE, ID_CLOSE), (HELP, ID_HELP)):
            if flags & bit:
                b = Button(self, bid)
                s.AddButton(b)
                if bid in (ID_OK, ID_YES):
                    b.SetDefault()
        s.Realize()
        return s

    CreateStdDialogButtonSizer = CreateSeparatedButtonSizer = CreateButtonSizer

    def CreateTextSizer(self, message, *_):
        s = BoxSizer(VERTICAL)
        s.Add(StaticText(self, label=str(message)))
        return s

    def Destroy(self):
        return TopLevelWindow.Destroy(self)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.Destroy()
        return False


def _user_closed():
    """The person closed the floating dialog with its close box or Escape."""
    shown = [w for w in _top_windows if w._wx_visible]
    if shown:
        _call(shown[-1]._wx_closed_by_user)


# ----------------------------------------------------------------------------- stock dialogs (drawn by the editor)

def _confirm(title, message, ok="OK", cancel=True):
    if _bridge is None:
        return True
    return bool(_bridge.confirm(str(title), str(message), ok, cancel))


def MessageBox(message, caption="Message", style=OK, parent=None, x=-1, y=-1):
    if not isinstance(style, int):
        style = OK
    if not _DOM and _bridge is None:
        _log_message("MessageBox", f"{caption}: {message}")
        return YES if style & YES else OK
    if style & YES:
        return YES if _confirm(caption, message, "Yes", "No") else NO
    if style & CANCEL:
        return OK if _confirm(caption, message, "OK", "Cancel") else CANCEL
    _confirm(caption, message, "OK", None)
    return OK


_messages = []           # headless: what plugins said


def _log_message(kind, text):
    _messages.append((kind, str(text)))
    if len(_messages) > 200:
        del _messages[:100]


class MessageDialog(Dialog):
    def __init__(self, parent=None, message="", caption="Message", style=OK | CENTRE, pos=DefaultPosition, *more, **kw):
        self._message, self._caption, self._mstyle = str(message), str(caption), style
        self._ext = ""
        self._labels = {}
        EvtHandler.__init__(self)
        self._wx_modal, self._wx_return, self._wx_visible, self._wx_destroyed = False, ID_CANCEL, False, False
        self._wx_parent, self._wx_children, self._wx_id, self._wx_name = None, [], NewId(), "messagedialog"

    def SetExtendedMessage(self, t):
        self._ext = str(t)

    def SetMessage(self, t):
        self._message = str(t)

    def SetYesNoLabels(self, yes, no):
        self._labels.update(yes=str(yes), no=str(no))
        return True

    def SetOKCancelLabels(self, ok, cancel):
        self._labels.update(ok=str(ok), cancel=str(cancel))
        return True

    def SetOKLabel(self, ok):
        self._labels["ok"] = str(ok)
        return True

    SetYesNoCancelLabels = lambda self, y, n, c: self.SetYesNoLabels(y, n)

    def ShowModal(self):
        text = self._message + ("\n\n" + self._ext if self._ext else "")
        if not _DOM and _bridge is None:
            _log_message("MessageDialog", f"{self._caption}: {text}")
            return ID_YES if self._mstyle & YES else ID_OK
        if self._mstyle & YES:
            return ID_YES if _confirm(self._caption, text, self._labels.get("yes", "Yes"), self._labels.get("no", "No")) else ID_NO
        if self._mstyle & CANCEL:
            return ID_OK if _confirm(self._caption, text, self._labels.get("ok", "OK"), self._labels.get("cancel", "Cancel")) else ID_CANCEL
        _confirm(self._caption, text, self._labels.get("ok", "OK"), None)
        return ID_OK

    def Destroy(self):
        return True

    def Show(self, show=True):
        if show:
            self.ShowModal()
        return True


GenericMessageDialog = RichMessageDialog = MessageDialog


class TextEntryDialog(MessageDialog):
    def __init__(self, parent=None, message="", caption="Please enter text", value="", style=OK | CANCEL, pos=DefaultPosition, *more, **kw):
        MessageDialog.__init__(self, parent, message, caption, style)
        self._value = str(kw.get("value", value))
        self._password = False

    def ShowModal(self):
        if _bridge is None:
            return ID_OK
        out = _bridge.prompt(self._caption, self._message, self._value)
        if out is None:
            return ID_CANCEL
        self._value = str(out)
        return ID_OK

    def GetValue(self):
        return self._value

    def SetValue(self, v):
        self._value = str(v)

    SetMaxLength = lambda self, n: None


class PasswordEntryDialog(TextEntryDialog):
    pass


def GetTextFromUser(message, caption="Input text", default_value="", parent=None, *_):
    d = TextEntryDialog(parent, message, caption, default_value)
    return d.GetValue() if d.ShowModal() == ID_OK else ""


def GetNumberFromUser(message, prompt, caption, value, min=0, max=100, parent=None, *_):
    d = TextEntryDialog(parent, f"{message}\n{prompt}", caption, str(value))
    if d.ShowModal() != ID_OK:
        return -1
    try:
        return int(float(d.GetValue()))
    except ValueError:
        return -1


class SingleChoiceDialog(MessageDialog):
    def __init__(self, parent=None, message="", caption="", choices=None, style=OK | CANCEL, *more, **kw):
        MessageDialog.__init__(self, parent, message, caption, style)
        self._choices = [str(c) for c in (kw.get("choices", choices) or [])]
        self._sel = 0

    def ShowModal(self):
        if _bridge is None:
            return ID_OK
        out = _bridge.choose(self._caption, self._message, self._choices, self._sel)
        if out is None:
            return ID_CANCEL
        self._sel = self._choices.index(out) if out in self._choices else 0
        return ID_OK

    def GetSelection(self):
        return self._sel

    def SetSelection(self, n):
        self._sel = n

    def GetStringSelection(self):
        return self._choices[self._sel] if self._choices else ""


class FileDialog(MessageDialog):
    """Opening reads a file the person picks into the plugin's own file system; saving names a file
    in the output folder, which the editor offers as a download when the plugin is done."""

    def __init__(self, parent=None, message="Select a file", defaultDir="", defaultFile="", wildcard="*.*", style=FD_DEFAULT_STYLE, pos=DefaultPosition, *more, **kw):
        MessageDialog.__init__(self, parent, message, kw.get("message", message), style)
        self._dir, self._file = str(kw.get("defaultDir", defaultDir) or ""), str(kw.get("defaultFile", defaultFile) or "")
        self._wild = str(kw.get("wildcard", wildcard) or "")
        self._fstyle = kw.get("style", style)
        self._path = ""
        self._filter = 0

    def _wx_exts(self):
        out = []
        parts = self._wild.split("|")
        for pat in parts[1::2] if len(parts) > 1 else parts:
            for p in pat.split(";"):
                p = p.strip()
                if p.startswith("*.") and p != "*.*" and p[2:].replace("_", "").isalnum():
                    out.append(p[1:])
        return out

    def ShowModal(self):
        if self._fstyle & FD_SAVE:
            name = self._file or "output"
            if _bridge is not None:
                got = _bridge.prompt(self._caption, "File name", name)
                if got is None:
                    return ID_CANCEL
                name = _os.path.basename(str(got)) or name
                exts = self._wx_exts()
                if exts and not _os.path.splitext(name)[1]:
                    name += exts[0]
            self._path = _os.path.join(_out_dir(), name)
            return ID_OK
        if _bridge is None:
            return ID_CANCEL
        got = _bridge.pick(self._caption, self._wx_exts())
        if not got:
            return ID_CANCEL
        self._path = got
        return ID_OK

    def GetPath(self):
        return self._path

    def GetPaths(self):
        return [self._path] if self._path else []

    def GetFilename(self):
        return _os.path.basename(self._path)

    GetFilenames = lambda self: [self.GetFilename()] if self._path else []

    def GetDirectory(self):
        return _os.path.dirname(self._path)

    def GetFilterIndex(self):
        return self._filter

    def SetPath(self, p):
        self._path = str(p)
        self._file = _os.path.basename(self._path)

    def SetFilename(self, f):
        self._file = str(f)

    def SetDirectory(self, d):
        self._dir = str(d)

    def SetWildcard(self, w):
        self._wild = str(w)

    SetFilterIndex = lambda self, i: setattr(self, "_filter", i)
    GetWildcard = lambda self: self._wild
    GetMessage = lambda self: self._message


def _out_dir():
    d = _os.environ.get("KICAD_WEB_OUTPUT", "/project")
    try:
        _os.makedirs(d, exist_ok=True)
    except OSError:
        pass
    return d


class DirDialog(MessageDialog):
    """There are no folders to choose from in a browser: the plugin is given the output folder."""

    def __init__(self, parent=None, message="Choose a directory", defaultPath="", style=DD_DEFAULT_STYLE, pos=DefaultPosition, *more, **kw):
        MessageDialog.__init__(self, parent, message, message, style)
        self._path = str(kw.get("defaultPath", defaultPath) or "") or _out_dir()

    def ShowModal(self):
        if not _os.path.isdir(self._path):
            self._path = _out_dir()
        return ID_OK

    def GetPath(self):
        return self._path

    def SetPath(self, p):
        self._path = str(p)


def FileSelector(message="Select a file", default_path="", default_filename="", default_extension="", wildcard="*.*", flags=0, parent=None, *_):
    d = FileDialog(parent, message, default_path, default_filename, wildcard, flags)
    return d.GetPath() if d.ShowModal() == ID_OK else ""


LoadFileSelector = lambda what, extension, default_name="", parent=None: FileSelector(what, "", default_name, extension, "*." + extension.lstrip("*."), FD_OPEN, parent)
SaveFileSelector = lambda what, extension, default_name="", parent=None: FileSelector(what, "", default_name, extension, "*." + extension.lstrip("*."), FD_SAVE, parent)


def DirSelector(message="Choose a directory", default_path="", *_):
    d = DirDialog(None, message, default_path)
    return d.GetPath() if d.ShowModal() == ID_OK else ""


class ProgressDialog:
    def __init__(self, title="", message="", maximum=100, parent=None, style=PD_APP_MODAL | PD_AUTO_HIDE):
        self._wx_title, self._max = str(title), maximum
        self.Update(0, message)

    def Update(self, value, newmsg=""):
        if _bridge is not None:
            pct = int(100 * value / self._max) if self._max else 0
            _bridge.status(f"{self._wx_title}: {newmsg} {pct}%".strip() if value < self._max else "")
        return (True, False)

    def Pulse(self, newmsg=""):
        if _bridge is not None:
            _bridge.status(f"{self._wx_title}: {newmsg}".strip())
        return (True, False)

    def Destroy(self):
        if _bridge is not None:
            _bridge.status("")
        return True

    Close = Hide = lambda self, *a: (_bridge.status("") if _bridge is not None else None, True)[1]
    Show = Resume = Raise = Fit = SetSize = Centre = Center = Refresh = Update_ = Layout = SetFocus = SetTitle = lambda self, *a, **k: True
    # it is a window on the desktop: plugins place it, keep it on top, restyle it
    CentreOnParent = CenterOnParent = CentreOnScreen = CenterOnScreen = SetPosition = Move = SetMinSize = SetMaxSize = SetIcon = lambda self, *a, **k: True
    SetWindowStyle = SetWindowStyleFlag = SetExtraStyle = Enable = Disable = lambda self, *a, **k: True
    ToggleWindowStyle = lambda self, flag: False
    GetWindowStyle = GetWindowStyleFlag = lambda self: 0
    IsShown = IsShownOnScreen = lambda self: True
    GetSize = lambda self: Size(300, 120)
    GetPosition = lambda self: Point(0, 0)
    GetTitle = lambda self: self._wx_title
    WasCancelled = WasSkipped = lambda self: False
    SetRange = lambda self, m: setattr(self, "_max", m)
    GetRange = lambda self: self._max
    GetValue = lambda self: 0
    GetMessage = lambda self: ""

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.Destroy()
        return False


GenericProgressDialog = ProgressDialog


class BusyInfo:
    def __init__(self, msg="", *a, **k):
        if _bridge is not None:
            _bridge.status(str(msg) if isinstance(msg, str) else "Working…")

    def __del__(self):
        try:
            if _bridge is not None:
                _bridge.status("")
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        if _bridge is not None:
            _bridge.status("")
        return False


class BusyCursor:
    def __init__(self, *a):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


WindowDisabler = BusyCursor
BeginBusyCursor = EndBusyCursor = lambda *a: None
IsBusy = lambda: False
HOURGLASS_CURSOR = STANDARD_CURSOR = NullCursor = None
(CURSOR_ARROW, CURSOR_WAIT, CURSOR_HAND, CURSOR_CROSS, CURSOR_IBEAM, CURSOR_SIZING, CURSOR_SIZENS, CURSOR_SIZEWE, CURSOR_SIZENESW,
 CURSOR_SIZENWSE, CURSOR_NO_ENTRY, CURSOR_ARROWWAIT, CURSOR_BLANK, CURSOR_MAGNIFIER, CURSOR_QUESTION_ARROW, CURSOR_PENCIL,
 CURSOR_BULLSEYE, CURSOR_DEFAULT, CURSOR_NONE, CURSOR_RIGHT_ARROW, CURSOR_CHAR, CURSOR_LEFT_BUTTON, CURSOR_MIDDLE_BUTTON,
 CURSOR_RIGHT_BUTTON, CURSOR_PAINT_BRUSH, CURSOR_POINT_LEFT, CURSOR_POINT_RIGHT, CURSOR_SPRAYCAN, CURSOR_WATCH, CURSOR_OPEN_HAND,
 CURSOR_CLOSED_HAND) = range(31)
_CURSOR_CSS = {CURSOR_ARROW: "default", CURSOR_WAIT: "wait", CURSOR_HAND: "pointer", CURSOR_CROSS: "crosshair", CURSOR_IBEAM: "text",
               CURSOR_SIZING: "move", CURSOR_SIZENS: "ns-resize", CURSOR_SIZEWE: "ew-resize", CURSOR_SIZENESW: "nesw-resize",
               CURSOR_SIZENWSE: "nwse-resize", CURSOR_NO_ENTRY: "not-allowed", CURSOR_ARROWWAIT: "progress", CURSOR_BLANK: "none",
               CURSOR_MAGNIFIER: "zoom-in", CURSOR_QUESTION_ARROW: "help", CURSOR_PENCIL: "crosshair", CURSOR_BULLSEYE: "crosshair",
               CURSOR_DEFAULT: "", CURSOR_NONE: "", CURSOR_WATCH: "wait", CURSOR_OPEN_HAND: "grab", CURSOR_CLOSED_HAND: "grabbing"}


class Cursor(_Thing):
    def __init__(self, *a, **k):
        _Thing.__init__(self, *a, **k)
        self._stock = a[0] if a and isinstance(a[0], int) else CURSOR_DEFAULT

    def IsOk(self):
        return True


def _win_set_cursor(self, cursor=None):
    stock = getattr(cursor, "_stock", CURSOR_DEFAULT) if cursor is not None else CURSOR_DEFAULT
    self.el.style.cursor = _CURSOR_CSS.get(stock, "")
    return True


Window.SetCursor = _win_set_cursor
NullCursor = Cursor(CURSOR_DEFAULT)


StockCursor = Cursor
SetCursor = lambda *a: None


class ColourData:
    def __init__(self, *a):
        self._colour = Colour(0, 0, 0)
        self._custom = {}
        self._full = True

    def GetColour(self):
        return self._colour

    def SetColour(self, c):
        self._colour = Colour(c)

    def GetChooseFull(self):
        return self._full

    def SetChooseFull(self, flag):
        self._full = bool(flag)

    GetChooseAlpha = lambda self: False
    SetChooseAlpha = lambda self, flag: None

    def GetCustomColour(self, i):
        return self._custom.get(int(i), Colour(255, 255, 255))

    def SetCustomColour(self, i, c):
        self._custom[int(i)] = Colour(c)

    ToString = lambda self: self._colour.GetAsString()
    FromString = lambda self, text: bool(self.SetColour(text) or True)


class ColourDialog(Dialog):
    """Choose a colour: the browser's own colour field in a small dialog."""

    def __init__(self, parent=None, data=None, *a, **k):
        Dialog.__init__(self, parent, title="Choose colour")
        self._data = ColourData()
        if isinstance(data, ColourData):
            self._data.SetColour(data.GetColour())
            self._data._custom = dict(data._custom)
        box = BoxSizer(VERTICAL)
        self._picker = ColourPickerCtrl(self, colour=self._data.GetColour())
        self._hex = TextCtrl(self, value=self._data.GetColour().GetAsString())
        row = BoxSizer(HORIZONTAL)
        row.Add(self._picker, 0, ALL, 6)
        row.Add(self._hex, 1, ALL | EXPAND, 6)
        box.Add(row, 0, EXPAND)
        box.Add(self.CreateButtonSizer(OK | CANCEL), 0, ALL | EXPAND, 6)
        self.SetSizer(box)
        self._picker.Bind(EVT_COLOURPICKER_CHANGED, lambda e: self._hex.SetValue(self._picker.GetColour().GetAsString()))          # noqa: F821
        self._hex.Bind(EVT_TEXT, self._wx_typed)          # noqa: F821

    def _wx_typed(self, event=None):
        text = self._hex.GetValue().strip()
        if len(text) == 7 and text[0] == "#" and all(ch in "0123456789abcdefABCDEF" for ch in text[1:]):
            self._picker.SetColour(Colour(text))

    def GetColourData(self):
        self._wx_typed()
        self._data.SetColour(self._picker.GetColour())
        return self._data


def GetColourFromUser(parent=None, colInit=None, caption="", data=None):
    d = ColourData()
    if colInit is not None:
        d.SetColour(colInit)
    dlg = ColourDialog(parent, d)
    try:
        return dlg.GetColourData().GetColour() if dlg.ShowModal() == ID_OK else Colour(0, 0, 0, 0)
    finally:
        dlg.Destroy()



# ----------------------------------------------------------------------------- application

class _PcbCanvas(Window):
    """The board editor's drawing area, as a window of its frame: plugins send it keys (KiCad's own hotkeys) and watch
    for clicks on it."""
    _wx_plain = True

    def __init__(self, frame):
        EvtHandler.__init__(self)
        self._wx_parent, self._wx_children, self._wx_id, self._wx_name = frame, [], NewId(), "GAL canvas"
        self._wx_shown, self._wx_enabled, self._wx_destroyed = True, True, False
        self._wx_style, self._wx_sizer, self._wx_tooltip, self._wx_font, self._wx_label, self._wx_data = 0, None, "", None, "", None
        self.el = _FakeEl("canvas")

    def _wx_box(self):
        return _pcb_frame._wx_box()

    IsShown = IsShownOnScreen = lambda self: True
    GetTitle = lambda self: ""

    def _wx_fire(self, binder, event=None):
        if binder in (EVT_CHAR, EVT_KEY_DOWN, EVT_CHAR_HOOK) and event is not None and callable(_editor.get("key")):          # noqa: F821
            return bool(_editor["key"](event))
        return EvtHandler._wx_fire(self, binder, event)


class _PcbFrame(Frame):
    """Stands for KiCad's board editor window.  Plugins look it up to parent their dialogs, and some work it as they
    would on the desktop: they find their own entry in Tools → External Plugins and choose it, choose Edit → Undo,
    send the canvas one of KiCad's hotkeys, or watch for the person's click on the board."""

    def __init__(self):
        EvtHandler.__init__(self)
        self._wx_parent, self._wx_children, self._wx_id, self._wx_name, self._wx_title = None, [], NewId(), "PcbFrame", "PCB Editor"
        self._wx_visible = self._wx_shown = self._wx_modal = self._wx_destroyed = False
        self._wx_style, self._wx_sizer, self._wx_enabled, self._wx_default, self._wx_want = 0, None, True, None, None
        self.el = _FakeEl("div")
        self._canvas = None
        self._bar = None
        self._plugin_items = {}          # menu item id -> the action plugin it runs
        self._undo_id = self._redo_id = None

    def _wx_adopt(self, child):
        pass

    def _wx_present(self):
        pass

    def _wx_box(self):
        if _DOM:
            try:
                return int(_js.innerWidth or 1280), int(_js.innerHeight or 800)
            except Exception:
                pass
        return 1280, 800

    def GetChildren(self):
        if self._canvas is None:
            self._canvas = _PcbCanvas(self)
        if callable(_editor.get("panels")):
            _editor["panels"](self)             # the editor's side panels, brought up to date with what they show
        return [self._canvas] + [c for c in self._wx_children if c is not self._canvas]

    def GetTitle(self):
        name = _editor["title"]() if callable(_editor.get("title")) else ""
        return (name + " \u2014 PCB Editor") if name else "PCB Editor"

    IsShown = IsShownOnScreen = IsActive = lambda self: True

    def GetMenuBar(self):
        if self._bar is None:
            self._bar = MenuBar()
            edit, tools, self._plugins_menu = Menu(), Menu(), Menu()
            self._undo_id = edit.Append(ID_UNDO, "Undo").GetId()
            self._redo_id = edit.Append(ID_REDO, "Redo").GetId()
            tools.AppendSubMenu(self._plugins_menu, "External Plugins")
            self._bar.Append(edit, "Edit")
            self._bar.Append(tools, "Tools")
        have = {id(p) for p in self._plugin_items.values()}
        for name, plugin in (_editor["actions"]() if callable(_editor.get("actions")) else []):
            if id(plugin) not in have:
                item = self._plugins_menu.Append(NewId(), name)
                self._plugin_items[item.GetId()] = plugin
        return self._bar

    def _wx_fire(self, binder, event=None):
        if isinstance(event, _paint.KeyEvent) and callable(_editor.get("key")):
            # a key sent to the editor's window (Ctrl+V after a plugin filled the clipboard, a hotkey): the editor acts on it
            if binder is None or binder in (EVT_CHAR_HOOK, EVT_KEY_DOWN, EVT_CHAR):          # noqa: F821
                if _editor["key"](event):
                    return True
        if binder is EVT_MENU and event is not None:          # noqa: F821
            eid = event.GetId()
            if eid in self._plugin_items and callable(_editor.get("run")):
                return bool(_editor["run"](self._plugin_items[eid]))
            if eid == self._undo_id and callable(_editor.get("undo")):
                return bool(_editor["undo"]())
            if eid == self._redo_id and callable(_editor.get("redo")):
                return bool(_editor["redo"]())
        return EvtHandler._wx_fire(self, binder, event)

    def Show(self, *a):
        return True

    def Destroy(self):
        return True


def _editor_canvas_event(kind, key=0):
    """Something happened on the board editor's canvas (the person clicked an item, pressed Escape): the event filters
    plugins installed are shown it, as wxWidgets shows a filter every event of the program."""
    if not _filters:
        return
    canvas = _pcb_frame.GetChildren()[0]
    if kind == "click":
        events = [_paint.MouseEvent(canvas, EVT_LEFT_DOWN, None, "mousedown"), _paint.MouseEvent(canvas, EVT_LEFT_UP, None, "mouseup")]          # noqa: F821
        for ev in events:
            ev._x, ev._y, ev._button = 400, 300, 0
    else:
        events = [_paint.KeyEvent(canvas, EVT_KEY_DOWN, key), _paint.KeyEvent(canvas, EVT_KEY_UP, key)]          # noqa: F821
    for ev in events:
        for f in list(_filters):
            try:
                _call(f.FilterEvent, ev)
            except Exception:
                import traceback
                traceback.print_exc()


_pcb_frame = _PcbFrame()


def GetTopLevelWindows():
    return [_pcb_frame] + [w for w in _top_windows]


def FindWindowByName(name, parent=None):
    for w in GetTopLevelWindows():
        if w.GetName() == name:
            return w
        if w is not _pcb_frame:
            r = w.FindWindowByName(name)
            if r is not None:
                return r
    return None


class _EditorGrid:
    """The board editor's grid selector, for plugins that read the current grid from KiCad's toolbar."""

    def _mm(self):
        import pcbnew
        return float(getattr(pcbnew._Host, "grid_mm", 0.25) or 0.25)

    def GetStringSelection(self):
        g = self._mm()
        return f"{g:.4f} mm ({g / 0.0254:.2f} mils)"

    GetValue = GetString = GetLabel = lambda self, *a: self.GetStringSelection()
    GetSelection = lambda self: 0
    GetCount = lambda self: 1
    GetStrings = GetItems = lambda self: [self.GetStringSelection()]


def FindWindowById(i, parent=None):
    for w in _top_windows:
        r = w.FindWindowById(i)
        if r is not None:
            return r
    if int(i) == 6211:
        return _EditorGrid()
    return None


FindWindowByLabel = lambda label, parent=None: None
GetActiveWindow = lambda: _pcb_frame
Window.FindFocus = staticmethod(lambda: None)


class App(EvtHandler):
    InitLocale = ResetLocale = lambda self, *a: None          # the page's own language settings apply

    def __init__(self, redirect=False, filename=None, useBestVisual=False, clearSigInt=True):
        EvtHandler.__init__(self)
        global _app
        _app = self
        self.OnInit()

    def OnInit(self):
        return True

    def OnExit(self):
        return 0

    def MainLoop(self):
        # A plugin KiCad loads into its own process returns at once: KiCad's loop is already
        # running.  A plugin that is its own program lives in this call until its last window closes.
        if not _process_mode:
            return 0
        _in_mainloop[0] += 1
        try:
            if not _DOM:
                if _headless_main is not None:
                    _headless_main()
                return 0
            while any(getattr(w, "_wx_visible", False) for w in _top_windows) and not self._wx_exit:
                _wait(_kc().sleep(60))
        finally:
            _in_mainloop[0] -= 1
            self._wx_exit = False
        return 0

    _wx_exit = False

    def ExitMainLoop(self):
        self._wx_exit = True

    def GetTopWindow(self):
        return _pcb_frame

    def SetTopWindow(self, w):
        pass

    def GetAppName(self):
        return "pcbnew"

    SetAppName = SetAppDisplayName = SetVendorName = SetExitOnFrameDelete = Yield = lambda self, *a: None
    GetAppDisplayName = lambda self: "KiCad"
    IsMainLoopRunning = lambda self: True
    GetTraits = lambda self: None

    @staticmethod
    def Get():
        return GetApp()

    @staticmethod
    def IsDisplayAvailable():
        return True

    GetInstance = Get


PySimpleApp = PyApp = App
_app = None


def GetApp():
    global _app
    if _app is None:
        _app = App()
    return _app


def Yield(*_):
    """Let the browser draw (a progress bar that moves, a log that fills) while the plugin works."""
    if _DOM:
        try:
            _wait(_kc().tick())
        except Exception:
            pass
    return True


SafeYield = YieldIfNeeded = Yield
WakeUpIdle = lambda: None
Exit = lambda: None
Bell = lambda: None


def CallAfter(fn, *a, **k):
    if _DOM:
        _kc().later(_once(lambda: _call(fn, *a, **k)), 0)
    else:
        fn(*a, **k)


_later = []                # headless: CallLater calls that are due, soonest first (there is no clock to wait on)


def _run_later(limit=400):
    """Headless: run the delayed calls that are waiting, in the order they would fall due, and those they start in
    turn.  A plugin that steps through its work with wx.CallLater does that work here.  Returns how many ran."""
    done = 0
    while _later and done < limit:
        _later.sort(key=lambda c: c._due)
        call = _later.pop(0)
        done += 1
        call._go()
    return done


class CallLater:
    _clock = [0]

    def __init__(self, millis, fn, *a, **k):
        self._fn, self._a, self._k, self._running = fn, a, k, True
        if _DOM:
            _kc().later(_once(self._go), int(millis))
        else:
            CallLater._clock[0] += 1
            self._due = (int(millis), CallLater._clock[0])
            _later.append(self)

    def _go(self):
        if self._running:
            self._running = False
            _call(self._fn, *self._a, **self._k)

    def Stop(self):
        self._running = False

    def IsRunning(self):
        return self._running

    Start = Restart = lambda self, *a, **k: None
    HasRun = lambda self: not self._running


FutureCall = CallLater


class Timer(EvtHandler):
    def __init__(self, owner=None, id=ID_ANY):
        EvtHandler.__init__(self)
        self._wx_owner, self._wx_id = owner, id if id != ID_ANY else NewId()
        self._gen, self._running = 0, False

    def GetId(self):
        return self._wx_id

    def SetOwner(self, owner, id=ID_ANY):
        self._wx_owner = owner

    def Start(self, milliseconds=-1, oneShot=False):
        self._gen += 1
        self._running = True
        gen = self._gen
        if _DOM:
            from pyodide.ffi import create_proxy

            def tick():
                if not self._running or gen != self._gen:
                    return
                if oneShot:
                    self._running = False
                else:
                    _kc().later(proxy, max(15, int(milliseconds)))
                self._wx_notify()
            proxy = create_proxy(tick)
            _kc().later(proxy, max(15, int(milliseconds)))
        return True

    StartOnce = lambda self, milliseconds=-1: self.Start(milliseconds, True)

    def _wx_notify(self):
        ev = Event(self, EVT_TIMER, self._wx_id)          # noqa: F821
        target = self._wx_owner if self._wx_owner is not None else self
        if not target._wx_fire(EVT_TIMER, ev):          # noqa: F821
            _call(self.Notify)

    def Notify(self):
        pass

    def Stop(self):
        self._running = False

    def IsRunning(self):
        return self._running

    GetInterval = lambda self: 0
    IsOneShot = lambda self: False


PyTimer = Timer


class _Log:
    def write(self, text):
        print(text, end="")


_pending_log = []          # (level, text): what wxLogGui would show in one window once the program is idle


def _log(level, msg, a):
    text = str(msg) % a if a else str(msg)
    print(("", "Warning: ", "Error: ")[level] + text, file=_sys.stderr if level else _sys.stdout)
    _pending_log.append((level, text))
    if len(_pending_log) > 200:
        del _pending_log[:100]


def _flush_log():
    """wxLogGui: messages, warnings and errors logged while an event was handled are shown to the person together, in
    one window, when the handler is done (the desktop shows them at the next idle time)."""
    if not _pending_log:
        return
    items = list(_pending_log)
    del _pending_log[:]
    level = max(l for l, _ in items)
    try:
        MessageBox("\n".join(t for _, t in items), "KiCad " + ("Information", "Warning", "Error")[level], OK | (ICON_INFORMATION, ICON_WARNING, ICON_ERROR)[level])
    except Exception as e:                      # a log window must never break the plugin
        print("the log window could not be shown:", e, file=_sys.stderr)


def LogMessage(msg, *a):
    _log(0, msg, a)


def LogInfo(msg, *a):                           # shown on the desktop only in verbose mode; status text goes to the status bar
    print(str(msg) % a if a else str(msg))


LogStatus = LogVerbose = LogDebug = LogInfo


def LogWarning(msg, *a):
    _log(1, msg, a)


def LogError(msg, *a):
    _log(2, msg, a)


LogSysError = LogFatalError = LogError
LogNull = BusyCursor


class Log:
    SetActiveTarget = staticmethod(lambda *a: None)
    GetActiveTarget = staticmethod(lambda: None)
    EnableLogging = staticmethod(lambda *a: True)
    SetLogLevel = staticmethod(lambda *a: None)
    FlushActive = staticmethod(lambda: None)


class LogStderr(_Thing):
    pass


LogTextCtrl = LogWindow = LogGui = LogBuffer = LogStderr


class ConfigBase(dict):
    """wx.Config, kept for the session."""

    def Read(self, key, default=""):
        return str(self.get(key, default))

    def ReadInt(self, key, default=0):
        return int(self.get(key, default))

    def ReadFloat(self, key, default=0.0):
        return float(self.get(key, default))

    def ReadBool(self, key, default=False):
        return bool(self.get(key, default))

    def Write(self, key, value):
        self[key] = value
        return True

    WriteInt = WriteFloat = WriteBool = Write
    Exists = HasEntry = lambda self, key: key in self
    Flush = lambda self, *a: True
    DeleteEntry = lambda self, key, *a: self.pop(key, None) is not None
    DeleteAll = lambda self: (self.clear(), True)[1]
    SetPath = lambda self, p: None
    GetPath = lambda self: "/"

    @staticmethod
    def Get(*_):
        return _config

    Set = staticmethod(lambda c: None)


_config = ConfigBase()
class Config(ConfigBase):
    def __init__(self, *a, **k):
        dict.__init__(self)


FileConfig = Config


class StandardPaths:
    @staticmethod
    def Get():
        return StandardPaths()

    GetUserConfigDir = GetUserDataDir = GetUserLocalDataDir = GetConfigDir = GetDataDir = lambda self: _os.environ.get("KICAD_WEB_CONFIG", "/config")
    GetDocumentsDir = GetTempDir = GetAppDocumentsDir = lambda self: _out_dir()
    GetExecutablePath = lambda self: "/usr/bin/kicad"
    GetResourcesDir = GetPluginsDir = GetInstallPrefix = lambda self: "/usr/share/kicad"
    GetUserDir = lambda self, *_: _out_dir()


class Locale:
    def __init__(self, *a, **k):
        pass

    AddCatalog = AddCatalogLookupPathPrefix = Init = lambda self, *a, **k: True
    GetCanonicalName = GetName = GetLocale = lambda self: "en_US"
    GetLanguage = lambda self: LANGUAGE_ENGLISH
    GetSystemLanguage = staticmethod(lambda: LANGUAGE_ENGLISH)
    GetLanguageInfo = FindLanguageInfo = staticmethod(lambda *a: None)
    IsOk = lambda self: True


GetLocale = lambda: Locale()
GetTranslation = lambda s, *a: s
_ = lambda s: s


class _Clipboard:
    _wx_last = ""

    @staticmethod
    def Get():
        return TheClipboard

    def Open(self):
        return True

    def Close(self):
        pass

    # Set by kicad_web: the board and schematic editors' own copy buffer (what Copy in this project's editor took, and
    # what its Paste will place).  It is the editor's buffer, not the computer's clipboard, which a plugin cannot read.
    _wx_read = None
    _wx_write = None

    def SetData(self, data):
        text = getattr(data, "_text", "")
        _Clipboard._wx_last = text
        if text and _Clipboard._wx_write:
            try:
                _Clipboard._wx_write(text)
            except Exception:
                pass
        return True

    def GetData(self, data):
        text = ""
        if _Clipboard._wx_read:
            try:
                text = _Clipboard._wx_read() or ""
            except Exception:
                text = ""
        text = text or _Clipboard._wx_last
        if text and hasattr(data, "SetText"):
            data.SetText(text)
            return True
        return False

    Flush = Clear = lambda self: True
    IsOpened = lambda self: False
    IsSupported = lambda self, *_: False
    UsePrimarySelection = lambda self, *_: None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class DropTarget:
    def __init__(self, data=None):
        self._data = data

    OnDrop = lambda self, x, y: True
    OnData = lambda self, x, y, default=None: default
    OnDragOver = OnEnter = lambda self, x, y, default=None: default
    OnLeave = lambda self: None
    SetDataObject = GetDataObject = SetDefaultAction = lambda self, *a: None


class FileDropTarget(DropTarget):
    def __init__(self):
        DropTarget.__init__(self)

    def OnDropFiles(self, x, y, filenames):
        return False


class TextDropTarget(DropTarget):
    def __init__(self):
        DropTarget.__init__(self)

    def OnDropText(self, x, y, text):
        return False


class UIActionSimulator:
    """Plugins use it to press keys in KiCad's window (Ctrl+V after filling the clipboard).  Keys go to the board editor;
    there is no pointer to move."""

    def _key(self, keycode, modifiers=0):
        ev = _paint.KeyEvent(_pcb_frame, EVT_CHAR_HOOK, int(keycode))          # noqa: F821
        ev.SetControlDown(bool(modifiers & (MOD_CONTROL | MOD_CMD)))
        ev.SetShiftDown(bool(modifiers & MOD_SHIFT))
        ev.SetAltDown(bool(modifiers & MOD_ALT))
        return bool(_pcb_frame._wx_fire(EVT_CHAR_HOOK, ev))          # noqa: F821

    def Char(self, keycode, modifiers=0):
        return self._key(keycode, modifiers)

    def KeyDown(self, keycode, modifiers=0):
        return self._key(keycode, modifiers)

    def KeyUp(self, keycode, modifiers=0):
        return True

    def Text(self, text):
        return True

    MouseMove = MouseDown = MouseUp = MouseClick = MouseDblClick = MouseDragDrop = lambda self, *a, **k: True


TheClipboard = _Clipboard()
Clipboard = _Clipboard


class TextDataObject:
    def __init__(self, text=""):
        self._text = str(text)

    def SetText(self, t):
        self._text = str(t)

    def GetText(self):
        return self._text


DF_TEXT, DF_UNICODETEXT, DF_BITMAP, DF_FILENAME = 1, 13, 2, 15
class DataFormat(_Thing):
    pass


def LaunchDefaultBrowser(url, *_):
    print(f"Open in a browser: {url}")
    return False


LaunchDefaultApplication = LaunchDefaultBrowser
GetDisplaySize = lambda: Size(1280, 800)
GetClientDisplayRect = lambda: Rect(0, 0, 1280, 800)
DisplaySize = lambda: (1280, 800)
GetMousePosition = lambda: Point(0, 0)
GetKeyState = lambda k: False
GetOsDescription = lambda: "Web"
GetOsVersion = lambda: (0, 0, 0)
GetHomeDir = GetUserHome = lambda *a: _out_dir()
GetUserId = GetUserName = lambda: "web"
GetLibraryVersionInfo = lambda: type("V", (), {"GetVersionString": lambda self: "wxWidgets 3.2 (web)", "ToString": lambda self: "wxWidgets 3.2 (web)", "Major": 3, "Minor": 2, "Micro": 6,
                                             "GetMajor": lambda self: 3, "GetMinor": lambda self: 2, "GetMicro": lambda self: 6, "GetName": lambda self: "wxWidgets", "GetDescription": lambda self: "wxWidgets 3.2 (web)"})()
Sleep = MilliSleep = lambda *a: None
IsMainThread = lambda: True
GetUTCTimeMillis = GetLocalTimeMillis = lambda: int(__import__("time").time() * 1000)
Now = lambda: __import__("time").strftime("%c")
MutexGuiEnter = MutexGuiLeave = lambda: None


class _Display:
    def __init__(self, *a):
        pass

    GetGeometry = GetClientArea = lambda self: Rect(0, 0, 1280, 800)
    GetPPI = lambda self: Size(96, 96)
    GetScaleFactor = lambda self: 1.0
    GetCount = staticmethod(lambda: 1)
    GetFromWindow = GetFromPoint = staticmethod(lambda *a: 0)


Display = _Display


class EventFilter(_Thing):
    Event_Skip, Event_Ignore, Event_Processed = -1, 0, 1


class SingleInstanceChecker:
    """Each run of a plugin in the web editor is the only one of its kind."""

    def __init__(self, *a, **k):
        pass

    Create = lambda self, *a, **k: True
    IsAnotherRunning = lambda self: False
    CreateDefault = lambda self: True


class Validator(EvtHandler):
    """A control's validator: asked when the person accepts the dialog, as on the desktop."""

    def __init__(self, *a, **k):
        EvtHandler.__init__(self)
        self._wx_window = None

    Clone = lambda self: self
    Validate = TransferToWindow = TransferFromWindow = lambda self, *a: True
    GetWindow = lambda self: self._wx_window

    def SetWindow(self, window):
        self._wx_window = window

    IsSilent = staticmethod(lambda: True)
    SuppressBellOnError = staticmethod(lambda *a: None)


PyValidator = DefaultValidator = Validator
DefaultValidator = Validator()


class MenuItem:
    def __init__(self, menu=None, id=ID_ANY, text="", helpString="", kind=ITEM_NORMAL, subMenu=None, *a, **k):
        self._wx_id = id if isinstance(id, int) and id not in (ID_ANY, ID_SEPARATOR) else NewId()
        self._text, self._kind, self._menu, self._sub = str(text), kind, menu, subMenu
        self._enabled, self._checked = True, False

    GetId = lambda self: self._wx_id
    GetItemLabelText = GetItemLabel = GetText = GetLabel = lambda self: self._text.replace("&", "")
    GetKind = lambda self: self._kind
    GetMenu = lambda self: self._menu
    GetSubMenu = lambda self: self._sub
    IsSeparator = lambda self: self._kind == ITEM_SEPARATOR
    IsCheckable = lambda self: self._kind in (ITEM_CHECK, ITEM_RADIO)
    IsEnabled = lambda self: self._enabled
    IsChecked = lambda self: self._checked
    SetBitmap = SetBitmaps = SetHelp = SetFont = SetTextColour = SetBackgroundColour = lambda self, *a: None

    def Enable(self, enable=True):
        self._enabled = bool(enable)

    def Check(self, check=True):
        self._checked = bool(check)

    def SetItemLabel(self, text):
        self._text = str(text)

    SetText = SetItemLabel


class Menu(EvtHandler):
    """A menu: shown by Window.PopupMenu as a list at the pointer, or by a frame's menu bar as a drop-down."""

    def __init__(self, *a, **k):
        EvtHandler.__init__(self)
        self._wx_items = []
        self._wx_title = a[0] if a and isinstance(a[0], str) else ""

    def _wx_parent_handler(self):
        return None

    def Append(self, id=ID_ANY, item="", helpString="", kind=ITEM_NORMAL, **kw):
        if isinstance(id, MenuItem):
            m = id
        else:
            sub = helpString if isinstance(helpString, Menu) else kw.get("subMenu")
            m = MenuItem(self, id, kw.get("text", item), "", kw.get("kind", kind), sub)
        m._menu = self
        self._wx_items.append(m)
        return m

    AppendItem = Append
    Insert = lambda self, pos, *a, **k: self.Append(*a, **k)
    Prepend = Append

    def AppendCheckItem(self, id=ID_ANY, item="", help=""):
        return self.Append(id, item, "", ITEM_CHECK)

    def AppendRadioItem(self, id=ID_ANY, item="", help=""):
        return self.Append(id, item, "", ITEM_RADIO)

    def AppendSeparator(self):
        m = MenuItem(self, ID_ANY, "", "", ITEM_SEPARATOR)
        self._wx_items.append(m)
        return m

    def AppendSubMenu(self, submenu, text="", help=""):
        m = MenuItem(self, ID_ANY, text, "", ITEM_NORMAL, submenu)
        self._wx_items.append(m)
        return m

    def AppendMenu(self, id, text="", submenu=None, help=""):
        return self.AppendSubMenu(submenu, text)

    def _wx_find(self, id):
        for m in self._wx_items:
            if m._wx_id == id:
                return m
            if m._sub is not None:
                f = m._sub._wx_find(id)
                if f is not None:
                    return f
        return None

    FindItemById = _wx_find
    GetMenuItems = lambda self: list(self._wx_items)
    GetMenuItemCount = lambda self: len(self._wx_items)

    def FindItem(self, text):
        return next((m._wx_id for m in self._wx_items if m.GetItemLabelText() == str(text).replace("&", "")), NOT_FOUND)

    def Enable(self, id, enable=True):
        m = self._wx_find(id)
        if m is not None:
            m.Enable(enable)

    def Check(self, id, check=True):
        m = self._wx_find(id)
        if m is not None:
            m.Check(check)

    def IsChecked(self, id):
        m = self._wx_find(id)
        return bool(m and m._checked)

    def IsEnabled(self, id):
        m = self._wx_find(id)
        return bool(m and m._enabled)

    def SetLabel(self, id, text):
        m = self._wx_find(id)
        if m is not None:
            m.SetItemLabel(text)

    def Remove(self, item):
        m = item if isinstance(item, MenuItem) else self._wx_find(item)
        if m in self._wx_items:
            self._wx_items.remove(m)
        return m

    Delete = DestroyItem = Remove
    Destroy = lambda self, *a: True
    UpdateUI = lambda self, *a: None

    def _wx_element(self, chosen):
        """The menu as a list of buttons; `chosen(item)` is called for the one the person picks."""
        box = _el("div", "wx-menu")
        for m in self._wx_items:
            if m._kind == ITEM_SEPARATOR:
                box.appendChild(_el("hr"))
                continue
            if m._sub is not None:
                head = _el("div", "wx-menu-sub")
                head.textContent = m.GetItemLabelText()
                box.appendChild(head)
                inner = m._sub._wx_element(chosen)
                inner.className = "wx-menu-in"
                box.appendChild(inner)
                continue
            b = _el("button")
            b.type = "button"
            b.textContent = ("✓ " if m._checked else "") + m.GetItemLabelText().split("\t")[0]
            b.disabled = not m._enabled
            _listen(b, "click", lambda e=None, m=m: chosen(m))
            box.appendChild(b)
        return box

    def _wx_pick(self, m, window=None):
        if m._kind == ITEM_CHECK:
            m._checked = not m._checked
        ev = Event(m, EVT_MENU, m._wx_id)          # noqa: F821
        ev._int = 1 if m._checked else 0
        menu = m._menu if m._menu is not None else self
        if menu._wx_fire(EVT_MENU, ev):          # noqa: F821
            return
        if menu is not self and self._wx_fire(EVT_MENU, ev):          # noqa: F821
            return
        if window is not None:
            window._wx_fire(EVT_MENU, ev)          # noqa: F821


_mouse = [40, 40]


def _wx_popup_menu(window, menu, pos=None):
    """Show `menu` at the pointer and wait for a choice (or a click elsewhere), as the desktop's PopupMenu does."""
    if not _DOM or not isinstance(menu, Menu) or not menu._wx_items:
        return False
    from pyodide.ffi import create_proxy
    done = {}
    promise = _js.Promise.new(create_proxy(lambda resolve, reject: done.__setitem__("ok", resolve)))
    veil = _el("div", "wx-menu-veil")
    picked = []

    def close(m=None):
        if m is not None:
            picked.append(m)
        veil.remove()
        done["ok"](None)

    box = menu._wx_element(close)
    x, y = (pos.x, pos.y) if isinstance(pos, Point) and pos.x >= 0 else _mouse
    box.style.left = f"{int(x)}px"
    box.style.top = f"{int(y)}px"
    veil.appendChild(box)
    veil.addEventListener("click", create_proxy(lambda e: close() if e.target == veil else None))
    _js.document.body.appendChild(veil)
    r = box.getBoundingClientRect()
    if r.right > _js.innerWidth:
        box.style.left = f"{max(0, int(_js.innerWidth - r.width - 4))}px"
    if r.bottom > _js.innerHeight:
        box.style.top = f"{max(0, int(_js.innerHeight - r.height - 4))}px"
    _wait(promise)
    if picked:
        menu._wx_pick(picked[0], window)
    return bool(picked)


if _DOM:
    def _track_mouse(e):
        _mouse[0], _mouse[1] = e.clientX, e.clientY
    from pyodide.ffi import create_proxy as _cp
    _js.document.addEventListener("mousedown", _cp(_track_mouse), True)
    _js.document.addEventListener("contextmenu", _cp(lambda e: (_track_mouse(e), e.preventDefault())), True)


class MenuBar(Window):
    """A frame's menu bar: a row of titles, each opening its menu."""
    _CLS = "wx-menubar"

    def __init__(self, *a, **k):
        Window.__init__(self, None)
        self._menus = []

    def Append(self, menu, title=""):
        b = _el("button")
        b.type = "button"
        b.textContent = str(title).replace("&", "")
        _listen(b, "click", lambda e=None: _wx_popup_menu(self._wx_parent, menu))
        self.el.appendChild(b)
        self._menus.append((menu, str(title)))
        return True

    Insert = lambda self, pos, menu, title="": self.Append(menu, title)
    GetMenuCount = lambda self: len(self._menus)
    GetMenu = lambda self, i: self._menus[i][0]
    GetMenus = lambda self: list(self._menus)

    def FindItemById(self, id):
        for m, _t in self._menus:
            f = m._wx_find(id)
            if f is not None:
                return f
        return None

    def Enable(self, id, enable=True):
        m = self.FindItemById(id)
        if m is not None:
            m.Enable(enable)

    def Check(self, id, check=True):
        m = self.FindItemById(id)
        if m is not None:
            m.Check(check)

    def IsChecked(self, id):
        m = self.FindItemById(id)
        return bool(m and m._checked)

    EnableTop = lambda self, *a: None


class ToolBar(Window):
    """A row of tool buttons; a click fires EVT_TOOL (and EVT_MENU) with the tool's id, as on the desktop."""
    _CLS = "wx-toolbar"

    def __init__(self, parent=None, id=ID_ANY, pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)
        self._tools = {}

    def AddTool(self, toolId=ID_ANY, label="", bitmap=None, *a, **kw):
        tid = toolId if isinstance(toolId, int) and toolId != ID_ANY else NewId()
        tip = kw.get("shortHelp") or next((x for x in a if isinstance(x, str) and x), "")
        kind = kw.get("kind", next((x for x in a if isinstance(x, int) and not isinstance(x, bool)), ITEM_NORMAL))
        b = _el("button")
        b.type = "button"
        url = getattr(bitmap, "_url", "") or getattr(kw.get("bitmap"), "_url", "")
        if url:
            img = _el("img")
            img.src = url
            b.appendChild(img)
        else:
            b.textContent = str(label or tip or "•")
        if tip or label:
            b.title = str(tip or label)
        tool = {"id": tid, "el": b, "kind": kind, "on": False, "enabled": True}
        self._tools[tid] = tool

        def clicked(e=None):
            if tool["kind"] in (ITEM_CHECK, ITEM_RADIO):
                tool["on"] = not tool["on"]
                b.classList.toggle("primary", tool["on"])
            for binder in (EVT_TOOL, EVT_MENU):          # noqa: F821
                ev = Event(self, binder, tid)
                ev._int = 1 if tool["on"] else 0
                if self._wx_fire(binder, ev):
                    break
        _listen(b, "click", clicked)
        self.el.appendChild(b)
        return _ToolItem(self, tool)

    AddLabelTool = AddSimpleTool = AddTool

    def AddCheckTool(self, toolId=ID_ANY, label="", bitmap=None, *a, **kw):
        kw["kind"] = ITEM_CHECK
        return self.AddTool(toolId, label, bitmap, **{k: v for k, v in kw.items() if k in ("shortHelp", "kind")})

    AddRadioTool = AddCheckTool

    def AddControl(self, control, label=""):
        if control._wx_parent is not self:
            control.Reparent(self)
        self.el.appendChild(control.el)
        return control

    def AddSeparator(self):
        self.el.appendChild(_el("span", "wx-toolsep"))

    def AddStretchableSpace(self):
        sp = _el("span")
        sp.style.flex = "1 1 0"
        self.el.appendChild(sp)

    def Realize(self):
        return True

    def EnableTool(self, toolId, enable=True):
        t = self._tools.get(toolId)
        if t:
            t["enabled"] = bool(enable)
            t["el"].disabled = not enable

    def GetToolEnabled(self, toolId):
        t = self._tools.get(toolId)
        return bool(t and t["enabled"])

    def ToggleTool(self, toolId, toggle=True):
        t = self._tools.get(toolId)
        if t:
            t["on"] = bool(toggle)
            if toggle:
                t["el"].classList.add("primary")
            else:
                t["el"].classList.remove("primary")

    def GetToolState(self, toolId):
        t = self._tools.get(toolId)
        return bool(t and t["on"])

    def DeleteTool(self, toolId):
        t = self._tools.pop(toolId, None)
        if t:
            t["el"].remove()
        return bool(t)

    def ClearTools(self):
        for tid in list(self._tools):
            self.DeleteTool(tid)

    def SetToolShortHelp(self, toolId, text):
        t = self._tools.get(toolId)
        if t:
            t["el"].title = str(text)

    GetToolsCount = lambda self: len(self._tools)


class _ToolItem:
    def __init__(self, bar, tool):
        self._bar, self._tool = bar, tool

    GetId = lambda self: self._tool["id"]
    Id = property(lambda self: self._tool["id"])
    IsToggled = lambda self: self._tool["on"]
    Enable = lambda self, enable=True: self._bar.EnableTool(self._tool["id"], enable)
    SetShortHelp = lambda self, text: self._bar.SetToolShortHelp(self._tool["id"], text)
    SetLongHelp = SetNormalBitmap = SetDisabledBitmap = SetLabel = lambda self, *a: None


class SplitterWindow(Window):
    """Two panes side by side or stacked.  The sash is fixed where the browser lays the panes out."""
    _CLS = "wx-split"

    def __init__(self, parent=None, id=ID_ANY, pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        Window.__init__(self, parent, id, pos, size, style, *more, **kw)
        self._panes = [None, None]
        self._sash = 0

    def _wx_adopt(self, child):
        self.el.appendChild(child.el)
        child.el.style.flex = "1 1 0"
        child.el.style.minWidth = "0"

    def Initialize(self, window):
        self._panes = [window, None]
        window.Show(True)

    def _wx_split(self, w1, w2, sash, direction):
        self._panes = [w1, w2]
        self.el.style.flexDirection = direction
        self.el.replaceChildren(w1.el, w2.el)
        w1.Show(True)
        w2.Show(True)
        self.SetSashPosition(sash)
        return True

    def SplitVertically(self, window1, window2, sashPosition=0):
        return self._wx_split(window1, window2, sashPosition, "row")

    def SplitHorizontally(self, window1, window2, sashPosition=0):
        return self._wx_split(window1, window2, sashPosition, "column")

    def Unsplit(self, toRemove=None):
        w = toRemove if toRemove is not None else self._panes[1]
        if w is not None:
            w.Show(False)
            self._panes = [p for p in self._panes if p is not w] + [None]
        return True

    def ReplaceWindow(self, old, new):
        self._panes = [new if p is old else p for p in self._panes]
        old.Show(False)
        self.el.appendChild(new.el)
        return True

    def IsSplit(self):
        return self._panes[1] is not None

    def GetWindow1(self):
        return self._panes[0]

    def GetWindow2(self):
        return self._panes[1]

    def SetSashPosition(self, position, redraw=True):
        self._sash = int(position or 0)
        w1 = self._panes[0]
        if w1 is not None and self._sash > 0:
            w1.el.style.flex = f"0 0 {self._sash}px"

    def GetSashPosition(self):
        return self._sash

    def GetSplitMode(self):
        return SPLIT_VERTICAL if str(self.el.style.flexDirection) != "column" else SPLIT_HORIZONTAL

    SetMinimumPaneSize = SetSashGravity = SetSashSize = SetSplitMode = UpdateSize = SetSashInvisible = lambda self, *a: None
    GetMinimumPaneSize = lambda self: 0
    GetSashGravity = lambda self: 0.5
    GetSashSize = lambda self: 4


SPLIT_HORIZONTAL, SPLIT_VERTICAL = 1, 2


class InfoBar(Window):
    """A strip across the top of a window with a message and a way to dismiss it."""
    _CLS = "wx-infobar"

    def _wx_build(self, kw):
        self._msg = _el("span")
        self.el.appendChild(self._msg)
        x = _el("button")
        x.type = "button"
        x.textContent = "×"
        _listen(x, "click", lambda e=None: self.Dismiss())
        self.el.appendChild(x)
        self.el.hidden = True

    def ShowMessage(self, msg, flags=ICON_INFORMATION):
        self._msg.textContent = str(msg)
        self.el.classList.toggle("warn", bool(flags & (ICON_WARNING | ICON_ERROR)))
        self.el.hidden = False
        t = self._wx_top()
        if t is not None:
            t._wx_refit()

    def Dismiss(self):
        self.el.hidden = True

    def IsShown(self):
        return not self.el.hidden

    AddButton = RemoveButton = SetShowHideEffects = SetEffectDuration = lambda self, *a: None


class PopupWindow(Panel):
    """A small window over the dialog (a tooltip-like panel): laid over the frame's content."""
    _CLS = "wx-panel wx-popup"

    def __init__(self, parent=None, flags=0, *a, **kw):
        Panel.__init__(self, parent)
        self.el.hidden = True
        if _DOM:
            _js.document.body.appendChild(self.el)

    def Position(self, origin=None, size=None):
        if isinstance(origin, Point):
            self.el.style.left = f"{int(origin.x)}px"
            self.el.style.top = f"{int(origin.y + (size[1] if size else 0))}px"

    def Popup(self, focus=None):
        if not str(self.el.style.left):
            self.el.style.left = f"{int(_mouse[0])}px"
            self.el.style.top = f"{int(_mouse[1])}px"
        self.el.hidden = False

    def Dismiss(self):
        self.el.hidden = True
        self.OnDismiss()

    def OnDismiss(self):
        pass

    def ProcessLeftDown(self, event):
        return False

    def Show(self, show=True):
        self.el.hidden = not show
        return True



# ----------------------------------------------------------------------------- pages of HTML
#
# wx.html.HtmlWindow and wx.html2.WebView: a plugin's own HTML (a rendered note, a report, a help page), shown in a
# frame that displays and never runs: no scripts, no forms, nothing fetched from the network, links inert.

_HTML_GUARD = ("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; "
               "style-src 'unsafe-inline'; font-src data:\"><style>a{pointer-events:none}</style>")


class HtmlWindow(Window):
    _TAG, _CLS = "iframe", "wx-html"

    def _wx_build(self, kw):
        self.el.setAttribute("sandbox", "")
        self.el.setAttribute("referrerpolicy", "no-referrer")
        self._wx_html, self._wx_url, self._wx_title = "", "", ""

    def SetPage(self, html, base_url=""):
        self._wx_html = str(html if html is not None else "")
        m = _re.search(r"<title[^>]*>(.*?)</title>", self._wx_html, _re.I | _re.S)
        self._wx_title = m.group(1).strip() if m else ""
        self.el.srcdoc = _HTML_GUARD + self._wx_html
        self._wx_fire(_binder("EVT_WEBVIEW_LOADED"))
        return True

    def AppendToPage(self, html):
        return self.SetPage(self._wx_html + str(html))

    def LoadURL(self, url):
        """A file of the plugin's is shown; an address on the web is named, not loaded."""
        url = str(url or "")
        self._wx_url = url
        path = url[7:] if url.startswith("file://") else url
        if _os.path.isfile(path):
            with open(path, encoding="utf-8", errors="replace") as fh:
                return self.SetPage(fh.read())
        import html as _h
        return self.SetPage("<p>This page is on the web and is not loaded inside a plugin's window:</p><p><b>%s</b></p>" % _h.escape(url))

    LoadPage = LoadFile = LoadURL

    def GetPageSource(self):
        return self._wx_html

    def GetPageText(self):
        import html as _h
        return _h.unescape(_re.sub(r"<[^>]+>", "", _re.sub(r"(?is)<(script|style)[^>]*>.*?</\\1>", "", self._wx_html)))

    ToText = SelectionToText = GetPageText
    GetCurrentURL = GetOpenedPage = lambda self: self._wx_url
    GetCurrentTitle = GetOpenedPageTitle = lambda self: self._wx_title
    RunScript = lambda self, *a, **k: (False, "")
    RunScriptAsync = AddScriptMessageHandler = AddUserScript = RemoveAllUserScripts = lambda self, *a, **k: False
    CanGoBack = CanGoForward = IsBusy = IsEditable = HistoryCanBack = HistoryCanForward = HistoryBack = HistoryForward = lambda self, *a: False
    Reload = Stop = GoBack = GoForward = ClearHistory = EnableHistory = EnableContextMenu = EnableAccessToDevTools = SetEditable = lambda self, *a, **k: None
    SetStandardFonts = SetFonts = SetBorders = SetRelatedFrame = SetRelatedStatusBar = SetZoom = SetZoomType = SetZoomFactor = SetUserAgent = lambda self, *a, **k: None
    GetZoom = GetZoomFactor = lambda self: 1
    Print = lambda self, *a: None

    @classmethod
    def New(cls, parent=None, id=ID_ANY, url="", pos=DefaultPosition, size=DefaultSize, backend="", style=0, name="", **kw):
        w = cls(parent, id, pos, size, style, name)
        if url:
            w.LoadURL(url)
        return w

    IsBackendAvailable = staticmethod(lambda *a: True)
    GetBackendVersionInfo = staticmethod(lambda *a: "web")


WebView = HtmlWindow


class StyledTextCtrl(TextCtrl):
    """A code editor on the desktop; here a plain multi-line text box holding the same text."""

    def __init__(self, parent=None, id=ID_ANY, pos=DefaultPosition, size=DefaultSize, style=0, *a, **kw):
        value = kw.pop("value", "")
        if isinstance(pos, str):                 # RichTextCtrl(parent, id, value, pos, size, style)
            value, pos, size, style = pos, size, style, (a[0] if a else 0)
        kw = {k: v for k, v in kw.items() if k in ("name",)}
        TextCtrl.__init__(self, parent, id, value, pos, size, (style if isinstance(style, int) else 0) | TE_MULTILINE, **kw)
        self.el.style.fontFamily = "var(--mono)"

    def GetText(self):
        return self.GetValue()

    def SetText(self, text):
        self.SetValue(text)

    def AddText(self, text):
        self.SetValue(self.GetValue() + str(text))

    WriteText = AppendText = AddText

    def ClearAll(self):
        self.SetValue("")

    def SetReadOnly(self, ro=True):
        self.SetEditable(not ro)

    def GetReadOnly(self):
        return not self.IsEditable()

    def GetLength(self):
        return len(self.GetValue())

    GetTextLength = GetLength

    def GetLineCount(self):
        return self.GetValue().count("\n") + 1

    def GetLine(self, n):
        lines = self.GetValue().split("\n")
        return lines[n] if 0 <= n < len(lines) else ""


class RichTextCtrl(StyledTextCtrl):
    """Rich text on the desktop; here its plain text.  Formatting calls (BeginBold, …) are accepted and ignored."""

    def Newline(self):
        self.AddText("\n")

    LineBreak = Newline

    def WriteImage(self, *a, **k):
        return False


class AcceleratorEntry:
    def __init__(self, flags=0, keyCode=0, cmd=0, item=None):
        self._flags, self._key, self._cmd = int(flags or 0), int(keyCode or 0), int(cmd or 0)

    Set = __init__
    GetFlags = lambda self: self._flags
    GetKeyCode = lambda self: self._key
    GetCommand = lambda self: self._cmd
    IsOk = lambda self: bool(self._key)

    def FromString(self, text):
        return False


class AcceleratorTable:
    """Keys that stand for menu commands in one window: (modifiers, key, command id)."""

    def __init__(self, entries=()):
        self._entries = []
        for e in entries or ():
            if isinstance(e, AcceleratorEntry):
                self._entries.append((e._flags, e._key, e._cmd))
            else:
                flags, key, cmd = tuple(e)[:3]
                self._entries.append((int(flags or 0), int(key), int(cmd)))

    IsOk = lambda self: True

    def _wx_command(self, event):
        """The command a key event stands for, or None."""
        code = event.GetKeyCode()
        flags = (ACCEL_CTRL if event.ControlDown() or event.MetaDown() else 0) | (ACCEL_SHIFT if event.ShiftDown() else 0) | (ACCEL_ALT if event.AltDown() else 0)
        for f, key, cmd in self._entries:
            k = ord(chr(key).upper()) if 0 < key < 256 else key
            if k == code and (f & (ACCEL_CTRL | ACCEL_SHIFT | ACCEL_ALT)) == flags:
                return cmd
        return None


def _set_accelerators(self, table):
    """Window.SetAcceleratorTable: from now a key pressed anywhere inside this window that the table names is the menu
    command it stands for (an EVT_MENU with that id), unless a handler in the window took the key first."""
    first = "_wx_accel" not in self.__dict__
    self.__dict__["_wx_accel"] = table if isinstance(table, AcceleratorTable) else None

    def down(e=None, key=None):
        t = self.__dict__.get("_wx_accel")
        if t is None:
            return False
        ev = _paint.KeyEvent(self, EVT_KEY_DOWN, e if e is not None else key)          # noqa: F821
        cmd = t._wx_command(ev)
        if cmd is None:
            return False
        menu = Event(self, EVT_MENU, cmd)          # noqa: F821
        handled = self._wx_fire(EVT_MENU, menu)          # noqa: F821
        if handled and e is not None and _DOM:
            e.preventDefault()
        return handled

    self.__dict__["_wx_accel_key"] = down
    if first:
        _listen(self.el, "keydown", lambda e=None: down(e))


Window.SetAcceleratorTable = _set_accelerators
Window.GetAcceleratorTable = lambda self: self.__dict__.get("_wx_accel")
# A key that works while another program has the keyboard: a page cannot have one, and says so (False, as on a desktop
# where another program already took the key).
Window.RegisterHotKey = lambda self, hotkeyId, modifiers=0, virtualKeyCode=0: False
Window.UnregisterHotKey = lambda self, hotkeyId: False
NullAcceleratorTable = None


class ImageList:
    def __init__(self, *a, **k):
        self._n = 0

    def Add(self, *a):
        self._n += 1
        return self._n - 1

    GetImageCount = lambda self: self._n
    RemoveAll = lambda self: True


# ----------------------------------------------------------------------------- drawing (wx/_paint.py)
from . import _paint          # noqa: E402
from ._paint import (DC, PaintDC, BufferedPaintDC, AutoBufferedPaintDC, ClientDC, WindowDC, ScreenDC, MemoryDC, BufferedDC, GCDC,          # noqa: E402,F401
                     AutoBufferedPaintDCFactory, Pen, PenInfo, Brush, GraphicsContext, GraphicsPath, GraphicsRenderer, GraphicsGradientStops,
                     MouseEvent, ThePenList, TheBrushList,
                     BLACK_PEN, WHITE_PEN, RED_PEN, GREEN_PEN, BLUE_PEN, CYAN_PEN, GREY_PEN, MEDIUM_GREY_PEN, LIGHT_GREY_PEN, TRANSPARENT_PEN, NullPen, NullGraphicsPen,
                     BLACK_BRUSH, WHITE_BRUSH, RED_BRUSH, GREEN_BRUSH, BLUE_BRUSH, CYAN_BRUSH, GREY_BRUSH, MEDIUM_GREY_BRUSH, LIGHT_GREY_BRUSH, TRANSPARENT_BRUSH,
                     NullBrush, NullGraphicsBrush, PENSTYLE_DOT, PENSTYLE_LONG_DASH, PENSTYLE_SHORT_DASH, PENSTYLE_DOT_DASH, PENSTYLE_USER_DASH,
                     PENSTYLE_TRANSPARENT, BRUSHSTYLE_TRANSPARENT)
DOT, LONG_DASH, SHORT_DASH, DOT_DASH, USER_DASH = PENSTYLE_DOT, PENSTYLE_LONG_DASH, PENSTYLE_SHORT_DASH, PENSTYLE_DOT_DASH, PENSTYLE_USER_DASH
BG_STYLE_ERASE, BG_STYLE_SYSTEM, BG_STYLE_PAINT, BG_STYLE_COLOUR, BG_STYLE_TRANSPARENT, BG_STYLE_CUSTOM = 0, 1, 2, 3, 4, 2
ANTIALIAS_NONE, ANTIALIAS_DEFAULT = 0, 1
INTERPOLATION_DEFAULT, INTERPOLATION_NONE, INTERPOLATION_FAST, INTERPOLATION_GOOD, INTERPOLATION_BEST = 0, 1, 2, 3, 4
CAP_ROUND, CAP_PROJECTING, CAP_BUTT, JOIN_BEVEL, JOIN_MITER, JOIN_ROUND = 130, 131, 132, 120, 121, 122
ODDEVEN_RULE, WINDING_RULE = 1, 2
IMAGE_QUALITY_NEAREST, IMAGE_QUALITY_BILINEAR, IMAGE_QUALITY_BICUBIC, IMAGE_QUALITY_BOX_AVERAGE, IMAGE_QUALITY_NORMAL, IMAGE_QUALITY_HIGH = 0, 1, 2, 3, 0, 4
BufferedPaintDCFactory = AutoBufferedPaintDCFactory


def _stub_class(name):
    cls = type(name, (_Stub,), {})
    return cls


# ----------------------------------------------------------------------------- keys, focus, scrolling, owner-drawn lists
import math as _math          # noqa: E402
from ._paint import KeyEvent, FocusEvent          # noqa: E402,F401
from ._tree import (TreeCtrl, HyperTreeList, TreeListCtrl, CustomTreeCtrl, GenericTreeCtrl, TreeItemId, TreeEvent, TreeItemData,          # noqa: E402,F401
                    TreeListColumnInfo)
from . import _tree as _tree_mod          # noqa: E402
for _n in dir(_tree_mod):
    if _n.startswith(("TR_", "TREE_HITTEST_", "EVT_TREE_", "TreeItemIcon_")):
        globals()[_n] = getattr(_tree_mod, _n)

SpinEvent = SpinDoubleEvent = BookCtrlEvent = NotebookEvent = ScrollWinEvent = ChildFocusEvent = EraseEvent = PaintEvent = Event
for _n in ("SCROLLWIN_THUMBTRACK", "SCROLLWIN_THUMBRELEASE", "SCROLLWIN_TOP", "SCROLLWIN_BOTTOM", "SCROLLWIN_LINEUP", "SCROLLWIN_LINEDOWN",
           "SCROLLWIN_PAGEUP", "SCROLLWIN_PAGEDOWN"):
    globals()["EVT_" + _n] = _binder("EVT_" + _n, False)
del _n
(WXK_END, WXK_HOME, WXK_INSERT, WXK_PAGEUP, WXK_PAGEDOWN, WXK_SHIFT, WXK_ALT, WXK_CONTROL, WXK_MENU, WXK_PAUSE, WXK_CAPITAL) = (
    312, 313, 322, 366, 367, 306, 307, 308, 309, 310, 311)
for _i in range(1, 25):
    globals()["WXK_F%d" % _i] = 339 + _i
del _i
WXK_NUMPAD0 = 324
(WXK_NUMPAD_SPACE, WXK_NUMPAD_TAB, WXK_NUMPAD_HOME, WXK_NUMPAD_LEFT, WXK_NUMPAD_UP, WXK_NUMPAD_RIGHT, WXK_NUMPAD_DOWN, WXK_NUMPAD_PAGEUP,
 WXK_NUMPAD_PAGEDOWN, WXK_NUMPAD_END, WXK_NUMPAD_DELETE, WXK_NUMPAD_ADD, WXK_NUMPAD_SUBTRACT) = (368, 369, 375, 376, 377, 378, 379, 380, 381, 382, 385, 388, 390)
WXK_NONE, WXK_WINDOWS_LEFT, WXK_WINDOWS_RIGHT, WXK_COMMAND = 0, 393, 394, 308
_focus = [None]          # the window that has the keyboard


def FindFocus():
    """The window with the keyboard.  When none of the plugin's own windows has it, it is where the person was when they
    started the plugin: the board editor's canvas."""
    w = _focus[0]
    if w is not None and not getattr(w, "_wx_destroyed", False) and getattr(w, "_wx_shown", True):
        return w
    return _pcb_frame.GetChildren()[0]


Window.FindFocus = staticmethod(FindFocus)


def GetTopLevelParent(window):
    return window.GetTopLevelParent() if window is not None else None


BORDER_MASK = 0x1f200000
SP_3D, SP_LIVE_UPDATE, SP_BORDER, SP_NOBORDER, SP_3DSASH, SP_3DBORDER, SP_NOSASH, SP_THIN_SASH, SP_PERMIT_UNSPLIT = 0x00C0, 0x0080, 0x0200, 0, 0x0100, 0x0200, 0x0010, 0, 0x0040
EVT_LIST_ITEM_FOCUSED = _binder("EVT_LIST_ITEM_FOCUSED")


def GetStockLabel(id, flags=0):
    return Button._STOCK.get(id, "")


def _win_has_focus(self):
    return _focus[0] is self or bool(self.__dict__.get("_wx_focused"))


def _win_set_focus(self):
    _paint._focusable(self)
    try:
        self.el.focus()
    except Exception:
        pass
    if not _DOM and _focus[0] is not self:
        old, _focus[0] = _focus[0], self
        if old is not None:
            old.__dict__["_wx_focused"] = False
            old._wx_fire(EVT_KILL_FOCUS, FocusEvent(old, EVT_KILL_FOCUS, self))          # noqa: F821
        self.__dict__["_wx_focused"] = True
        self._wx_fire(EVT_SET_FOCUS, FocusEvent(self, EVT_SET_FOCUS, old))          # noqa: F821


def _win_scroller(self):
    return self.el


def _win_scroll_pos(self, orientation=VERTICAL):
    try:
        el = self._wx_scroller()
        return int(el.scrollLeft if orientation == HORIZONTAL else el.scrollTop)
    except Exception:
        return 0


def _win_set_scroll_pos(self, orientation, pos, refresh=True):
    try:
        el = self._wx_scroller()
        if orientation == HORIZONTAL:
            el.scrollLeft = int(pos)
        else:
            el.scrollTop = int(pos)
    except Exception:
        pass


def _win_scroll_range(self, orientation=VERTICAL):
    try:
        el = self._wx_scroller()
        return int(el.scrollWidth if orientation == HORIZONTAL else el.scrollHeight)
    except Exception:
        return 0


def _win_scroll_thumb(self, orientation=VERTICAL):
    w, h = self._wx_box()
    return w if orientation == HORIZONTAL else h


def _win_screen_pos(self):
    if _DOM:
        try:
            r = self.el.getBoundingClientRect()
            return Point(int(r.left), int(r.top))
        except Exception:
            pass
    return Point(0, 0)


def _win_pos(self):
    if _DOM:
        try:
            return Point(int(self.el.offsetLeft), int(self.el.offsetTop))
        except Exception:
            pass
    return Point(0, 0)


def _xy(a):
    if len(a) >= 2:
        return int(a[0]), int(a[1])
    p = a[0] if a else (0, 0)
    return int(p[0]), int(p[1])


def _win_to_screen(self, *a):
    x, y = _xy(a)
    o = _win_screen_pos(self)
    return Point(o.x + x, o.y + y)


def _win_to_client(self, *a):
    x, y = _xy(a)
    o = _win_screen_pos(self)
    return Point(x - o.x, y - o.y)


def _win_text_extent(self, text):
    w, h = _paint.text_extent(text, self.GetFont())
    return Size(int(_math.ceil(w)), int(_math.ceil(h)))


Window.HasFocus = _win_has_focus
Window.SetFocus = Window.SetFocusFromKbd = _win_set_focus
Window._wx_scroller = _win_scroller
Window.GetScrollPos = _win_scroll_pos
Window.SetScrollPos = _win_set_scroll_pos
Window.GetScrollRange = _win_scroll_range
Window.GetScrollThumb = _win_scroll_thumb
Window.SetScrollbar = lambda self, *a, **k: None
Window.ScrollWindow = lambda self, *a, **k: None
Window.SetThemeEnabled = lambda self, *a: None
Window.GetThemeEnabled = lambda self: False
Window.UnsetToolTip = lambda self: Window.SetToolTip(self, "")
Window.GetScreenPosition = _win_screen_pos
Window.GetPosition = _win_pos
Window.GetScreenRect = lambda self: Rect(_win_screen_pos(self).x, _win_screen_pos(self).y, *self._wx_box())
Window.ClientToScreen = _win_to_screen
Window.ScreenToClient = _win_to_client
Window.GetTextExtent = _win_text_extent
Window.GetFullTextExtent = lambda self, text, *a: (_win_text_extent(self, text).x, _win_text_extent(self, text).y, 0, 0)
Window.AcceptsFocus = Window.AcceptsFocusFromKeyboard = Window.CanAcceptFocus = lambda self: True
Window.IsShownOnScreen = lambda self: self.IsShown()
App.SetAppearance = lambda self, *a: 0
App.GetAppearance = lambda self: 0


class VListBox(Panel):
    """A list whose rows the plugin measures and draws itself (OnMeasureItem, OnDrawItem): the rows are
    painted on one canvas as tall as the whole list, inside a box that scrolls."""

    def __init__(self, parent=None, id=ID_ANY, pos=DefaultPosition, size=DefaultSize, style=0, *more, **kw):
        self._vl_count, self._vl_sel, self._vl_multi = 0, -1, set()
        self._vl_heights, self._vl_selbg = [], None
        Panel.__init__(self, parent, id, pos, size, style, *more, **kw)
        self.el.style.overflowY = "auto"
        self.el.style.overflowX = "hidden"
        if not (size is not None and tuple(size)[1] > 0):
            self.el.style.minHeight = "60px"
        self._vl_rows = Panel(self)
        self._vl_rows.el.style.width = "100%"
        self._vl_rows.Bind(EVT_PAINT, self._vl_paint)          # noqa: F821
        for binder in (EVT_LEFT_DOWN, EVT_LEFT_DCLICK, EVT_KEY_DOWN):          # noqa: F821
            _paint.wire(self, binder)

    # -- for the plugin to override
    def OnMeasureItem(self, index):
        return 20

    def OnDrawItem(self, dc, rect, index):
        pass

    def OnDrawSeparator(self, dc, rect, index):
        pass

    def OnDrawBackground(self, dc, rect, index):
        if self.IsSelected(index):
            dc.SetBrush(Brush(self._vl_selbg or SystemSettings.GetColour(SYS_COLOUR_HIGHLIGHT)))
            dc.SetPen(TRANSPARENT_PEN)
            dc.DrawRectangle(rect)

    # -- rows
    def _vl_measure(self):
        hs = []
        for i in range(self._vl_count):
            try:
                hs.append(max(1, int(self.OnMeasureItem(i))))
            except Exception:
                hs.append(20)
        self._vl_heights = hs
        total = sum(hs)
        self._vl_rows.el.style.height = f"{total}px"
        self._vl_rows.__dict__["_wx_min"] = (-1, total)
        return total

    def _vl_width(self):
        w = self._wx_box()[0]
        return w if w > 0 else 200

    def _vl_paint(self, event=None):
        dc = PaintDC(self._vl_rows)
        w, y = self._vl_width(), 0
        for i, h in enumerate(self._vl_heights):
            r = Rect(0, y, w, h)
            self.OnDrawBackground(dc, Rect(r.x, r.y, r.width, r.height), i)
            self.OnDrawSeparator(dc, r, i)
            self.OnDrawItem(dc, r, i)
            y += h

    def SetItemCount(self, count):
        self._vl_count = max(0, int(count))
        if self._vl_sel >= self._vl_count:
            self._vl_sel = -1
        self._vl_multi = {i for i in self._vl_multi if i < self._vl_count}
        self._vl_measure()
        self.RefreshAll()

    SetRowCount = SetItemCount
    GetItemCount = GetRowCount = lambda self: self._vl_count

    def Clear(self):
        self.SetItemCount(0)

    def RefreshAll(self, *_):
        if len(self._vl_heights) != self._vl_count:
            self._vl_measure()
        _paint.schedule_paint(self._vl_rows)

    RefreshRow = RefreshRows = Refresh = RefreshAll

    def GetSelection(self):
        return self._vl_sel

    def SetSelection(self, index):
        index = int(index)
        self._vl_sel = index if 0 <= index < self._vl_count else -1
        if self._vl_sel >= 0:
            self.ScrollToRow(self._vl_sel, False)
        self.RefreshAll()
        return True

    def IsSelected(self, index):
        return index == self._vl_sel or index in self._vl_multi

    IsCurrent = lambda self, index: index == self._vl_sel
    HasMultipleSelection = lambda self: bool(self._wx_style & LB_MULTIPLE)
    GetSelectedCount = lambda self: len(self._vl_multi) if self._vl_multi else (1 if self._vl_sel >= 0 else 0)

    def Select(self, index, select=True):
        if select:
            self._vl_multi.add(int(index))
        else:
            self._vl_multi.discard(int(index))
        self.RefreshAll()
        return True

    def SelectAll(self):
        self._vl_multi = set(range(self._vl_count))
        self.RefreshAll()

    def DeselectAll(self):
        self._vl_multi = set()
        self.RefreshAll()

    def GetFirstSelected(self):
        s = sorted(self._vl_multi)
        return (s[0], 0) if s else (-1, 0)

    def GetNextSelected(self, cookie):
        s = sorted(self._vl_multi)
        return (s[cookie + 1], cookie + 1) if cookie + 1 < len(s) else (-1, cookie)

    def SetSelectionBackground(self, colour):
        self._vl_selbg = colour

    GetSelectionBackground = lambda self: self._vl_selbg or SystemSettings.GetColour(SYS_COLOUR_HIGHLIGHT)
    SetMargins = lambda self, *a: None
    GetMargins = lambda self: Point(0, 0)

    def _vl_top(self, index):
        return sum(self._vl_heights[:index])

    def VirtualHitTest(self, y):
        y = int(y) + self.GetScrollPos(VERTICAL)
        top = 0
        for i, h in enumerate(self._vl_heights):
            if top <= y < top + h:
                return i
            top += h
        return NOT_FOUND

    def HitTest(self, *a):
        return self.VirtualHitTest(_xy(a)[1])

    def GetItemRect(self, index):
        if not 0 <= index < len(self._vl_heights):
            return Rect(0, 0, 0, 0)
        return Rect(0, self._vl_top(index) - self.GetScrollPos(VERTICAL), self._vl_width(), self._vl_heights[index])

    def GetVisibleRowsBegin(self):
        i = self.VirtualHitTest(0)
        return max(0, i)

    def GetVisibleRowsEnd(self):
        h = self._wx_box()[1]
        i = self.VirtualHitTest(max(0, h - 1)) if h > 0 else NOT_FOUND
        return self._vl_count if i == NOT_FOUND else i + 1

    GetVisibleBegin, GetVisibleEnd = GetVisibleRowsBegin, GetVisibleRowsEnd

    def IsVisible(self, index):
        return self.GetVisibleRowsBegin() <= index < self.GetVisibleRowsEnd()

    IsRowVisible = IsVisible

    def ScrollToRow(self, index, always=True):
        if not 0 <= index < len(self._vl_heights):
            return False
        top, h, view = self._vl_top(index), self._vl_heights[index], self._wx_box()[1]
        pos = self.GetScrollPos(VERTICAL)
        if always or top < pos:
            self.SetScrollPos(VERTICAL, top)
        elif view > 0 and top + h > pos + view:
            self.SetScrollPos(VERTICAL, top + h - view)
        return True

    ScrollToLine = ScrollToRow
    ScrollRows = ScrollLines = ScrollRowPages = ScrollPages = lambda self, *a: False

    def DoGetBestSize(self):
        return Size(120, max(60, min(240, sum(self._vl_heights))))

    # -- what the list does by itself with a click or a key the plugin did not take
    def _vl_choose(self, index, binder):
        if index == NOT_FOUND:
            return
        self._vl_sel = index
        self.RefreshAll()
        ev = Event(self, binder)
        ev._int = index
        ev.GetInt = ev.GetSelection = lambda: index
        self._wx_fire(binder, ev)

    def _wx_default_mouse(self, ev):
        if ev._kind == "mousedown" and ev._button in (0, -1):
            self.SetFocus()
            self._vl_choose(self.VirtualHitTest(ev.GetY()), EVT_LISTBOX)          # noqa: F821
        elif ev._kind == "dblclick":
            self._vl_choose(self.VirtualHitTest(ev.GetY()), EVT_LISTBOX_DCLICK)          # noqa: F821

    def _wx_default_key(self, ev):
        code, n = ev.GetKeyCode(), self._vl_count
        if not n:
            return False
        step = {WXK_UP: -1, WXK_DOWN: 1, WXK_PAGEUP: -8, WXK_PAGEDOWN: 8}.get(code)
        if code == WXK_HOME:
            target = 0
        elif code == WXK_END:
            target = n - 1
        elif step is not None:
            target = max(0, min(n - 1, (self._vl_sel if self._vl_sel >= 0 else (0 if step > 0 else n) - step) + step))
        else:
            return False
        self.ScrollToRow(target, False)
        self._vl_choose(target, EVT_LISTBOX)          # noqa: F821
        return True


HtmlListBox = SimpleHtmlListBox = VListBox
VScrolledWindow = HVScrolledWindow = HScrolledWindow = ScrolledWindow


class PopupTransientWindow(PopupWindow):
    """A popup that goes away when the person clicks anywhere else (a drop-down list, a small editor)."""

    def __init__(self, parent=None, flags=0, *a, **kw):
        PopupWindow.__init__(self, parent, flags)
        self.__dict__["_wx_owner"] = parent
        if _DOM:
            def outside(e=None):
                if self.el.hidden or getattr(self, "_wx_destroyed", False):
                    return
                try:
                    if self.el.contains(e.target):
                        return
                    owner = self.__dict__.get("_wx_owner")
                    if owner is not None and owner.el.contains(e.target) and self.__dict__.get("_wx_just_shown"):
                        return
                except Exception:
                    return
                self.Dismiss()
            _listen(_js.document, "mousedown", outside)

    def Popup(self, focus=None):
        self.__dict__["_wx_just_shown"] = True
        PopupWindow.Popup(self, focus)
        self.el.style.zIndex = "100000"
        if _DOM:
            _kc().later(_once(lambda: self.__dict__.__setitem__("_wx_just_shown", False)), 0)
        else:
            self.__dict__["_wx_just_shown"] = False
        if focus is not None and hasattr(focus, "SetFocus"):
            focus.SetFocus()

    def Dismiss(self):
        was = not self.el.hidden
        self.el.hidden = True
        if was:
            self.OnDismiss()

    def IsShown(self):
        return not self.el.hidden


def _popup_position(self, origin=None, size=None):
    """Position(point on the screen, size of the thing it belongs to): just below that thing."""
    if origin is None:
        return
    x, y = int(origin[0]), int(origin[1])
    h = int(size[1]) if size is not None else 0
    self.el.style.position = "fixed"
    self.el.style.left = f"{x}px"
    self.el.style.top = f"{y + h}px"


def _popup_set_size(self, *a, **k):
    nums = [int(v) for v in (a[0] if len(a) == 1 and not isinstance(a[0], (int, float)) else a)]
    if len(nums) == 4:
        self.el.style.position = "fixed"
        self.el.style.left, self.el.style.top = f"{nums[0]}px", f"{nums[1]}px"
        nums = nums[2:]
    if len(nums) >= 2:
        if nums[0] > 0:
            self.el.style.width = f"{nums[0]}px"
        if nums[1] > 0:
            self.el.style.height = f"{nums[1]}px"
        self.__dict__["_wx_min"] = (nums[0], nums[1])


PopupWindow.Position = _popup_position
PopupWindow.SetSize = PopupWindow.SetClientSize = PopupWindow.SetInitialSize = _popup_set_size
PopupWindow.Move = PopupWindow.SetPosition = lambda self, *a: _popup_position(self, Point(*_xy(a)))
ComboPopup = PopupTransientWindow



_SUBMODULES = ("adv", "lib", "grid", "dataview", "xrc", "html", "html2", "aui", "richtext", "stc", "propgrid", "svg", "media", "glcanvas", "core", "ribbon")


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    if name in _SUBMODULES:          # wxPython loads most of these with wx itself: `wx.adv.X` works without importing wx.adv
        import importlib
        return importlib.import_module("wx." + name)
    _missing.add(name)
    if name.startswith("EVT_"):
        b = _binder(name)
        globals()[name] = b
        return b
    if name.startswith("wxEVT_"):
        b = globals().get("EVT_" + name[6:])
        if b is None:
            b = _binder("EVT_" + name[6:])
            globals()["EVT_" + name[6:]] = b
        globals()[name] = b.typeId
        return b.typeId
    if name.isupper() or (name[:1].isupper() and "_" in name and name.replace("_", "").isupper()):
        return _Zero(0)
    if name[:1].isupper():
        cls = _stub_class(name)
        globals()[name] = cls
        return cls
    raise AttributeError(f"module 'wx' has no attribute '{name}'")
