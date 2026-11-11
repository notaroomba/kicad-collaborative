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
FLP_OPEN, FLP_SAVE, FLP_USE_TEXTCTRL, FLP_DEFAULT_STYLE, DIRP_DEFAULT_STYLE, DIRP_USE_TEXTCTRL = 0x0400, 0x0800, 0x0002, 0x2402, 0x000a, 0x0002
PD_APP_MODAL, PD_AUTO_HIDE, PD_CAN_ABORT, PD_ELAPSED_TIME, PD_ESTIMATED_TIME, PD_REMAINING_TIME, PD_SMOOTH, PD_CAN_SKIP = 0x0001, 0x0004, 0x0002, 0x0008, 0x0010, 0x0040, 0x0020, 0x0080
TEXT_ALIGNMENT_LEFT = 1
BITMAP_TYPE_ANY, BITMAP_TYPE_BMP, BITMAP_TYPE_ICO, BITMAP_TYPE_PNG, BITMAP_TYPE_JPEG, BITMAP_TYPE_XPM, BITMAP_TYPE_GIF = 50, 1, 3, 15, 17, 9, 13
FONTFAMILY_DEFAULT, FONTFAMILY_DECORATIVE, FONTFAMILY_ROMAN, FONTFAMILY_SCRIPT, FONTFAMILY_SWISS, FONTFAMILY_MODERN, FONTFAMILY_TELETYPE = 70, 71, 72, 73, 74, 75, 76
FONTSTYLE_NORMAL, FONTSTYLE_ITALIC, FONTSTYLE_SLANT, FONTWEIGHT_NORMAL, FONTWEIGHT_LIGHT, FONTWEIGHT_BOLD = 90, 93, 94, 400, 300, 700
DEFAULT, DECORATIVE, ROMAN, SCRIPT, SWISS, MODERN, TELETYPE, NORMAL, ITALIC, SLANT, LIGHT, BOLD = 70, 71, 72, 73, 74, 75, 76, 90, 93, 94, 300, 700
(SYS_COLOUR_WINDOW, SYS_COLOUR_WINDOWTEXT, SYS_COLOUR_BTNFACE, SYS_COLOUR_BTNTEXT, SYS_COLOUR_HIGHLIGHT, SYS_COLOUR_HIGHLIGHTTEXT,
 SYS_COLOUR_GRAYTEXT, SYS_COLOUR_BACKGROUND, SYS_COLOUR_3DFACE, SYS_COLOUR_MENU, SYS_COLOUR_INFOBK, SYS_COLOUR_INFOTEXT, SYS_COLOUR_LISTBOX,
 SYS_COLOUR_FRAMEBK, SYS_COLOUR_ACTIVECAPTION, SYS_COLOUR_INACTIVECAPTION, SYS_COLOUR_CAPTIONTEXT, SYS_COLOUR_3DLIGHT, SYS_COLOUR_WINDOWFRAME,
 SYS_COLOUR_BTNHIGHLIGHT, SYS_COLOUR_BTNSHADOW, SYS_COLOUR_HOTLIGHT, SYS_COLOUR_APPWORKSPACE, SYS_COLOUR_MENUTEXT, SYS_COLOUR_LISTBOXTEXT) = range(25)
SYS_DEFAULT_GUI_FONT, SYS_ANSI_FIXED_FONT, SYS_SYSTEM_FONT, SYS_OEM_FIXED_FONT = 17, 11, 13, 10
SYS_SCREEN_X, SYS_SCREEN_Y, SYS_VSCROLL_X, SYS_HSCROLL_Y = 1, 2, 28, 29
NOT_FOUND = -1
WXK_RETURN, WXK_ESCAPE, WXK_TAB, WXK_DELETE, WXK_BACK, WXK_SPACE, WXK_NUMPAD_ENTER, WXK_UP, WXK_DOWN, WXK_LEFT, WXK_RIGHT, WXK_F1 = 13, 27, 9, 127, 8, 32, 370, 315, 317, 314, 316, 340
MOD_NONE, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_CMD = 0, 1, 2, 4, 2
ACCEL_NORMAL, ACCEL_ALT, ACCEL_CTRL, ACCEL_SHIFT = 0, 1, 2, 4
LANGUAGE_DEFAULT, LANGUAGE_ENGLISH = 0, 58
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


RealPoint = Point
Point2D = Point


class Rect:
    def __init__(self, x=0, y=0, width=0, height=0):
        self.x, self.y, self.width, self.height = x, y, width, height

    def GetWidth(self):
        return self.width

    def GetHeight(self):
        return self.height

    def GetSize(self):
        return Size(self.width, self.height)

    def GetPosition(self):
        return Point(self.x, self.y)

    def Get(self):
        return (self.x, self.y, self.width, self.height)

    def __iter__(self):
        return iter(self.Get())


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


class Font:
    def __init__(self, pointSize=10, family=FONTFAMILY_DEFAULT, style=FONTSTYLE_NORMAL, weight=FONTWEIGHT_NORMAL, underline=False, faceName="", *_, **kw):
        if isinstance(pointSize, Font):
            f = pointSize
            pointSize, family, style, weight, underline, faceName = f._size, f._family, f._wx_style, f._weight, f._underline, f._face
        elif not isinstance(pointSize, (int, float)):
            pointSize = 10
        self._size, self._family, self._wx_style, self._weight, self._underline, self._face = pointSize, family, style, weight, underline, kw.get("faceName", faceName)

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

    def SetFaceName(self, n):
        self._face = n
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
        if self._weight >= FONTWEIGHT_BOLD:
            el.style.fontWeight = "600"
        if self._wx_style in (FONTSTYLE_ITALIC, FONTSTYLE_SLANT):
            el.style.fontStyle = "italic"
        if self._family in (FONTFAMILY_MODERN, FONTFAMILY_TELETYPE):
            el.style.fontFamily = "var(--mono)"
        if self._size and abs(self._size - 10) >= 1:
            el.style.fontSize = f"{max(8, min(28, self._size * 1.2)):.0f}px"
        if self._underline:
            el.style.textDecoration = "underline"


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
        self._f._face = n
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


class Bitmap:
    def __init__(self, name=None, *a, **k):
        self._url = ""
        self._w = self._h = 16
        if isinstance(name, str) and name:
            self._url = _data_url(name)
        elif isinstance(name, (Bitmap, Image)):
            self._url, self._w, self._h = name._url, name._w, name._h
        elif isinstance(name, int) and a and isinstance(a[0], int):
            self._w, self._h = name, a[0]

    def IsOk(self):
        return bool(self._url)

    Ok = IsOk

    def GetWidth(self):
        return self._w

    def GetHeight(self):
        return self._h

    def GetSize(self):
        return Size(self._w, self._h)

    def ConvertToImage(self):
        return Image(self)

    def LoadFile(self, name, *_):
        self._url = _data_url(name)
        return bool(self._url)

    def SetSize(self, *a):
        pass

    def GetScaleFactor(self):
        return 1.0

    @staticmethod
    def FromRGBA(w, h, *_):
        return Bitmap(w, h)

    @staticmethod
    def NewFromPNGData(data, *_):
        b = Bitmap()
        b._url = "data:image/png;base64," + _b64.b64encode(bytes(data)).decode("ascii")
        return b

    FromPNGData = NewFromPNGData

    def CopyFromIcon(self, icon):
        self._url = icon._url

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return _NULL


class Image(Bitmap):
    def Scale(self, w, h, *_):
        i = Image(self)
        i._w, i._h = w, h
        return i

    Rescale = Scale

    def ConvertToBitmap(self, *_):
        return Bitmap(self)

    def HasAlpha(self):
        return True

    def SaveFile(self, *_):
        return False


class Icon(Bitmap):
    def CopyFromBitmap(self, bmp):
        self._url = bmp._url


class BitmapBundle(Bitmap):
    @staticmethod
    def FromBitmap(b):
        return BitmapBundle(b)

    FromSVGFile = staticmethod(lambda path, size=None: Bitmap(path))

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
ART_OTHER, ART_BUTTON, ART_MESSAGE_BOX, ART_TOOLBAR, ART_MENU, ART_CMN_DIALOG, ART_FRAME_ICON = "other", "button", "msgbox", "toolbar", "menu", "dialog", "frame"


class ArtProvider:
    GetBitmap = staticmethod(lambda *a, **k: Bitmap())
    GetIcon = staticmethod(lambda *a, **k: Icon())
    GetBitmapBundle = staticmethod(lambda *a, **k: BitmapBundle())


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
wxEVT_COMMAND_BUTTON_CLICKED = wxEVT_BUTTON = EVT_BUTTON.typeId          # noqa: F821
wxEVT_CLOSE_WINDOW = EVT_CLOSE.typeId          # noqa: F821
wxEVT_NULL = 0


def NewEventType():
    return NewId()


class Event:
    def __init__(self, source=None, binder=None, eid=None):
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


def PostEvent(target, event):
    if target is not None and event._binder is not None:
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

    Connect = lambda self, id1, id2, evtType, func: None
    Disconnect = lambda self, *a, **k: True

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
    AddFilter = RemoveFilter = staticmethod(lambda *a: None)
    SetEvtHandlerEnabled = lambda self, on: None


def _call(fn, *a):
    try:
        fn(*a)
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
.wx-list{min-height:60px;overflow:auto;border:1px solid var(--line);border-radius:3px;background:var(--panel)}
.wx-list label{display:flex;gap:5px;align-items:center;padding:1px 6px}
.wx-table{overflow:auto;border:1px solid var(--line);border-radius:3px;min-height:60px}
.wx-table tr.sel td{background:color-mix(in srgb,var(--blue) 25%,transparent)}
.wx-table td input{width:100%;border:0;background:none;padding:1px 2px}
.wx-table table{border-collapse:collapse;width:100%}
.wx-table th{position:sticky;top:0;background:var(--panel);border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:2px 6px;font-weight:600;text-align:left;white-space:nowrap}
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
.wx-stdbtns{display:flex;justify-content:flex-end;gap:6px;align-self:stretch;padding-top:6px}
textarea{resize:vertical;min-height:60px}
select[multiple]{min-height:70px}
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


class Window(EvtHandler):
    _TAG = "div"
    _CLS = "wx-panel"

    def __init__(self, parent=None, id=ID_ANY, pos=DefaultPosition, size=DefaultSize, style=0, name="", **kw):
        EvtHandler.__init__(self)
        _ensure_css()
        self._wx_parent = parent if isinstance(parent, Window) else None
        self._wx_id = id if isinstance(id, int) and id != ID_ANY else NewId()
        self._wx_style = style if isinstance(style, int) else 0
        self._wx_name = name if isinstance(name, str) else ""
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
        size = kw.get("size", size)
        if size is not None and tuple(size) != (-1, -1):
            self.SetMinSize(size)

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
        return 100, 24

    def GetSize(self):
        return Size(*self._wx_box())

    GetClientSize = GetBestSize = GetMinSize = GetVirtualSize = GetEffectiveMinSize = GetBestVirtualSize = GetMaxSize = GetSize
    GetSizeTuple = lambda self: tuple(self._wx_box())
    GetRect = GetClientRect = GetScreenRect = lambda self: Rect(0, 0, *self._wx_box())
    GetPosition = GetScreenPosition = lambda self: Point(0, 0)
    GetTextExtent = lambda self, text: Size(int(len(str(text)) * 7), 16)
    GetFullTextExtent = lambda self, text, *_: (int(len(str(text)) * 7), 16, 0, 0)
    GetCharWidth = lambda self: 7
    GetCharHeight = lambda self: 16
    GetDPIScaleFactor = GetContentScaleFactor = lambda self: 1.0
    FromDIP = ToDIP = ConvertDialogToPixels = ConvertPixelsToDialog = lambda self, v, *_: v
    ClientToScreen = ScreenToClient = lambda self, *a: Point(0, 0)

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

    def GetHandle(self):
        return 0

    def PopupMenu(self, menu, *a):
        return _wx_popup_menu(self, menu, a[0] if a and isinstance(a[0], Point) else None)

    def __getattr__(self, name):
        # Layout and look calls that mean nothing in a browser (Centre, Refresh, Thaw, …) are accepted.
        if name.startswith("_") or name in ("el",):
            raise AttributeError(name)
        if name[:1].isupper():
            _missing.add(f"{type(self).__name__}.{name}")
            return _NULL
        raise AttributeError(name)


Control = Window
PyWindow = PyControl = Window


class Panel(Window):
    pass


PyPanel = Panel


class ScrolledWindow(Panel):
    def _wx_build(self, kw):
        self.el.style.overflow = "auto"

    def SetScrollRate(self, *_):
        pass

    SetScrollbars = EnableScrolling = Scroll = SetupScrolling = lambda self, *a, **k: None


ScrolledPanel = ScrolledWindow


class _Labelled(Window):
    def __init__(self, parent=None, id=ID_ANY, label="", pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        self._init_label = label if isinstance(label, str) else ""
        Window.__init__(self, parent, id, pos, size, style, **kw)
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
        _set_img(self.el, bmp, self._wx_label)

    SetBitmapLabel = SetBitmap
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
    def __init__(self, parent=None, id=ID_ANY, bitmap=None, pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        Button.__init__(self, parent, id, "", pos, size, style, **kw)
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
        self.input.checked = bool(v)

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


class TextCtrl(Window):
    def __init__(self, parent=None, id=ID_ANY, value="", pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        self._multi = bool((style if isinstance(style, int) else 0) & TE_MULTILINE)
        self._TAG = "textarea" if self._multi else "input"
        Window.__init__(self, parent, id, pos, size, style, **kw)
        self.SetValue(value if isinstance(value, str) else "")

    _CLS = ""

    def _wx_build(self, kw):
        if not self._multi:
            self.el.type = "password" if self._wx_style & TE_PASSWORD else "text"
        else:
            self.el.rows = 6
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

    def __init__(self, parent=None, id=ID_ANY, pos=DefaultPosition, size=DefaultSize, choices=None, style=0, **kw):
        self._wx_items = []
        self._wx_client = []
        Window.__init__(self, parent, id, pos, size, style, **kw)
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
        self.el.selectedIndex = int(n)

    Select = SetSelection

    def GetStringSelection(self):
        i = self.GetSelection()
        return self._wx_items[i] if i >= 0 else ""

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

    def __init__(self, parent=None, id=ID_ANY, value="", pos=DefaultPosition, size=DefaultSize, choices=None, style=0, **kw):
        self._ro = bool((style if isinstance(style, int) else 0) & CB_READONLY)
        self._TAG = "select" if self._ro else "input"
        self._CLS = ""
        _Choices.__init__(self, parent, id, pos, size, choices, style, **kw)
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
            self.el.selectedIndex = int(n)
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

    def __init__(self, parent=None, id=ID_ANY, label="", pos=DefaultPosition, size=DefaultSize, choices=None, majorDimension=0, style=RA_SPECIFY_COLS, **kw):
        self._choices = list(kw.get("choices", choices) or [])
        self._rlabel = label if isinstance(label, str) else ""
        self._major = majorDimension
        Window.__init__(self, parent, id, pos, size, style, **kw)

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

    def __init__(self, parent=None, id=ID_ANY, value="", pos=DefaultPosition, size=DefaultSize, style=SP_ARROW_KEYS, min=0, max=100, initial=0, inc=1, **kw):
        self._lo, self._hi, self._inc = kw.get("min", min), kw.get("max", max), kw.get("inc", inc)
        Window.__init__(self, parent, id, pos, size, style, **kw)
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

    def __init__(self, parent=None, id=ID_ANY, value=0, minValue=0, maxValue=100, pos=DefaultPosition, size=DefaultSize, style=SL_HORIZONTAL, **kw):
        self._lo, self._hi = kw.get("minValue", minValue), kw.get("maxValue", maxValue)
        Window.__init__(self, parent, id, pos, size, style, **kw)
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

    def __init__(self, parent=None, id=ID_ANY, range=100, pos=DefaultPosition, size=DefaultSize, style=GA_HORIZONTAL, **kw):
        self._range = kw.get("range", range)
        Window.__init__(self, parent, id, pos, size, style, **kw)

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

    def __init__(self, parent=None, id=ID_ANY, bitmap=None, pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        Window.__init__(self, parent, id, pos, size, style, **kw)
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

    def __init__(self, parent=None, id=ID_ANY, label="", pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        self._blabel = label if isinstance(label, str) else ""
        Window.__init__(self, parent, id, pos, size, style, **kw)

    def _wx_build(self, kw):
        self._legend = _el("legend")
        self._legend.textContent = self._blabel
        self.el.appendChild(self._legend)

    def SetLabel(self, text):
        self._wx_label = self._blabel = str(text)
        self._legend.textContent = self._blabel

    def GetLabel(self):
        return self._blabel


class HyperlinkCtrl(_Labelled):
    _TAG, _CLS = "a", ""

    def __init__(self, parent=None, id=ID_ANY, label="", url="", pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        self._url = kw.get("url", url)
        _Labelled.__init__(self, parent, id, label or self._url, pos, size, style, **kw)

    def _wx_build(self, kw):
        self.el.title = str(self._url)
        _listen(self.el, "click", lambda e=None: self._wx_fire(EVT_HYPERLINK, Event(self, EVT_HYPERLINK)))          # noqa: F821

    def _wx_show_label(self):
        self.el.textContent = self._wx_label

    def GetURL(self):
        return self._url

    def SetURL(self, u):
        self._url = u


class Notebook(Window):
    def _wx_build(self, kw):
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

    def __init__(self, parent=None, id=ID_ANY, label="", pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        self._plabel = label if isinstance(label, str) else ""
        Window.__init__(self, parent, id, pos, size, style, **kw)

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
        th = _el("th")
        th.textContent = text
        self._head.appendChild(th)
        self._cols.append(text)
        return len(self._cols) - 1

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
        self._rows.insert(index, row)
        self._table.appendChild(tr)
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
            self._rows[index]["cells"][col] = str(label)
            self._rows[index]["tds"][col].textContent = str(label)
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
            self._rows[index]["sel"] = bool(on)
            self._rows[index]["tr"].classList.toggle("sel", bool(on))

    def SetItemState(self, index, state, mask):
        if mask & LIST_STATE_SELECTED:
            self.Select(index, bool(state & LIST_STATE_SELECTED))

    def GetItemState(self, index, mask):
        return LIST_STATE_SELECTED if self._rows[index]["sel"] else 0

    def Focus(self, index):
        pass

    def GetFocusedItem(self):
        return self.GetFirstSelected()

    SetColumnWidth = EnsureVisible = SetImageList = AssignImageList = SetItemBackgroundColour = SetItemTextColour = SetItemFont = EnableCheckBoxes = SortItems = lambda self, *a, **k: None
    GetColumnWidth = lambda self, c: 80
    IsItemChecked = lambda self, i: False
    CheckItem = lambda self, i, on=True: None


ListView = ListCtrl


class ListItem:
    def __init__(self, text="", index=0):
        self._text, self._index = text, index

    def GetText(self):
        return self._text

    def SetText(self, t):
        self._text = t

    def GetId(self):
        return self._index

    SetId = lambda self, i: setattr(self, "_index", i)
    SetColumn = SetMask = SetWidth = SetAlign = SetImage = SetData = lambda self, *a: None


class ToolTip:
    def __init__(self, text=""):
        self._text = str(text)

    def GetTip(self):
        return self._text

    SetTip = lambda self, t: setattr(self, "_text", str(t))
    Enable = SetDelay = SetAutoPop = staticmethod(lambda *a: None)


class _Picker(Window):
    """FilePickerCtrl / DirPickerCtrl: a text field holding the path."""
    _CLS = "wx-sizer wx-h"
    _DIR = False

    def __init__(self, parent=None, id=ID_ANY, path="", message="", wildcard="*.*", pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        self._wild = kw.get("wildcard", wildcard)
        Window.__init__(self, parent, id, pos, size, style, **kw)
        self.SetPath(kw.get("path", path))

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
        return str(self._text.value)

    def SetPath(self, p):
        self._text.value = str(p or "")

    SetInitialDirectory = lambda self, d: None
    GetTextCtrl = lambda self: None
    GetPickerCtrl = lambda self: None


class FilePickerCtrl(_Picker):
    pass


class DirPickerCtrl(_Picker):
    _DIR = True

    def __init__(self, parent=None, id=ID_ANY, path="", message="", pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        _Picker.__init__(self, parent, id, path, message, "", pos, size, style, **kw)


class ColourPickerCtrl(Window):
    _TAG, _CLS = "input", ""

    def __init__(self, parent=None, id=ID_ANY, colour=None, pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        Window.__init__(self, parent, id, pos, size, style, **kw)
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

    def __init__(self, parent=None, id=ID_ANY, title="", pos=DefaultPosition, size=DefaultSize, style=DEFAULT_DIALOG_STYLE, name="", **kw):
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

    def Centre(self, *_):
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
    def __init__(self, parent=None, id=ID_ANY, title="", pos=DefaultPosition, size=DefaultSize, style=DEFAULT_FRAME_STYLE, name="frame", **kw):
        TopLevelWindow.__init__(self, parent, id, title, pos, size, style, name, **kw)


MiniFrame = Frame


class Dialog(TopLevelWindow):
    def __init__(self, parent=None, id=ID_ANY, title="", pos=DefaultPosition, size=DefaultSize, style=DEFAULT_DIALOG_STYLE, name="dialog", **kw):
        TopLevelWindow.__init__(self, parent, id, title, pos, size, style, name, **kw)
        self._affirmative, self._escape = ID_OK, ID_CANCEL

    def ShowModal(self):
        self._wx_modal = True
        self._wx_return = ID_CANCEL
        self._wx_fire(EVT_INIT_DIALOG, Event(self, EVT_INIT_DIALOG))          # noqa: F821
        if not _DOM:
            self._wx_visible = self._wx_shown = True
            self._wx_fire(EVT_SHOW, Event(self, EVT_SHOW))          # noqa: F821
            code = _headless_modal(self) if _headless_modal is not None else ID_CANCEL
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
    def __init__(self, parent=None, message="", caption="Message", style=OK | CENTRE, pos=DefaultPosition, **kw):
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
    def __init__(self, parent=None, message="", caption="Please enter text", value="", style=OK | CANCEL, pos=DefaultPosition, **kw):
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
    def __init__(self, parent=None, message="", caption="", choices=None, style=OK | CANCEL, **kw):
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

    def __init__(self, parent=None, message="Select a file", defaultDir="", defaultFile="", wildcard="*.*", style=FD_DEFAULT_STYLE, pos=DefaultPosition, **kw):
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

    def __init__(self, parent=None, message="Choose a directory", defaultPath="", style=DD_DEFAULT_STYLE, pos=DefaultPosition, **kw):
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
    Show = Resume = Raise = Fit = SetSize = Centre = Center = lambda self, *a: True
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
CURSOR_WAIT, CURSOR_ARROW, CURSOR_HAND = 1, 0, 2
class Cursor(_Thing):
    pass


StockCursor = Cursor
SetCursor = lambda *a: None


# ----------------------------------------------------------------------------- application

class _PcbFrame(Frame):
    """Stands for KiCad's board editor window, which plugins look up to parent their dialogs."""

    def __init__(self):
        EvtHandler.__init__(self)
        self._wx_parent, self._wx_children, self._wx_id, self._wx_name, self._wx_title = None, [], NewId(), "PcbFrame", "PCB Editor"
        self._wx_visible = self._wx_shown = self._wx_modal = self._wx_destroyed = False
        self._wx_style, self._wx_sizer, self._wx_enabled, self._wx_default, self._wx_want = 0, None, True, None, None
        self.el = _FakeEl("div")

    def _wx_adopt(self, child):
        pass

    def _wx_present(self):
        pass

    def GetTitle(self):
        return "PCB Editor"

    def Show(self, *a):
        return True

    def Destroy(self):
        return True


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
        from pyodide.ffi import create_once_callable
        _kc().later(create_once_callable(lambda: _call(fn, *a, **k)), 0)
    else:
        fn(*a, **k)


class CallLater:
    def __init__(self, millis, fn, *a, **k):
        self._fn, self._a, self._k, self._running = fn, a, k, True
        if _DOM:
            from pyodide.ffi import create_once_callable
            _kc().later(create_once_callable(self._go), int(millis))

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


def LogMessage(msg, *a):
    print(str(msg) % a if a else str(msg))


LogInfo = LogStatus = LogVerbose = LogDebug = LogMessage


def LogWarning(msg, *a):
    print("Warning:", str(msg) % a if a else str(msg), file=_sys.stderr)


def LogError(msg, *a):
    print("Error:", str(msg) % a if a else str(msg), file=_sys.stderr)


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

    def SetData(self, data):
        text = getattr(data, "_text", "")
        _Clipboard._wx_last = text
        if _DOM and text:
            try:
                _kc().copy(text)
            except Exception:
                pass
        return True

    def GetData(self, data):
        # The browser does not let a frame read the clipboard; what this plugin itself copied can be read back.
        if _Clipboard._wx_last and hasattr(data, "SetText"):
            data.SetText(_Clipboard._wx_last)
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


class Validator:
    def __init__(self, *a, **k):
        pass

    Clone = lambda self: self
    Validate = TransferToWindow = TransferFromWindow = lambda self, *a: True


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

    def __init__(self, parent=None, id=ID_ANY, pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        Window.__init__(self, parent, id, pos, size, style, **kw)
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
    IsToggled = lambda self: self._tool["on"]
    Enable = lambda self, enable=True: self._bar.EnableTool(self._tool["id"], enable)
    SetShortHelp = lambda self, text: self._bar.SetToolShortHelp(self._tool["id"], text)
    SetLongHelp = SetNormalBitmap = SetDisabledBitmap = SetLabel = lambda self, *a: None


class SplitterWindow(Window):
    """Two panes side by side or stacked.  The sash is fixed where the browser lays the panes out."""
    _CLS = "wx-split"

    def __init__(self, parent=None, id=ID_ANY, pos=DefaultPosition, size=DefaultSize, style=0, **kw):
        Window.__init__(self, parent, id, pos, size, style, **kw)
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


PopupTransientWindow = PopupWindow


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


class AcceleratorTable(_Thing):
    pass


AcceleratorEntry = AcceleratorTable
NullAcceleratorTable = None


class ImageList:
    def __init__(self, *a, **k):
        self._n = 0

    def Add(self, *a):
        self._n += 1
        return self._n - 1

    GetImageCount = lambda self: self._n
    RemoveAll = lambda self: True


class DC:
    """Custom drawing is not carried to the web; the calls are accepted."""

    def __init__(self, *a, **k):
        pass

    def GetTextExtent(self, text):
        return (int(len(str(text)) * 7), 16)

    GetMultiLineTextExtent = GetTextExtent
    GetFullTextExtent = lambda self, text, *_: (int(len(str(text)) * 7), 16, 0, 0)
    GetSize = lambda self: Size(100, 100)
    GetCharHeight = lambda self: 16
    GetCharWidth = lambda self: 7

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


PaintDC = ClientDC = MemoryDC = BufferedPaintDC = AutoBufferedPaintDC = WindowDC = ScreenDC = BufferedDC = GCDC = DC
class Pen(_Thing):
    pass


class Brush(_Thing):
    pass
BLACK_PEN = WHITE_PEN = TRANSPARENT_PEN = BLACK_BRUSH = WHITE_BRUSH = TRANSPARENT_BRUSH = NullPen = NullBrush = None
GraphicsContext = type("GraphicsContext", (), {"Create": staticmethod(lambda *a: DC())})


def _stub_class(name):
    cls = type(name, (_Stub,), {})
    return cls


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
        return hash(name) & 0xFFFF
    if name.isupper() or (name[:1].isupper() and "_" in name and name.replace("_", "").isupper()):
        return _Zero(0)
    if name[:1].isupper():
        cls = _stub_class(name)
        globals()[name] = cls
        return cls
    raise AttributeError(f"module 'wx' has no attribute '{name}'")
