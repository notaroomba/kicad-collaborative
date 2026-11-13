# pcbnew.py — KiCad's pcbnew scripting API for the web editor.
#
# Official KiCad plugins are Python programs written against the `pcbnew` module the desktop
# application provides.  On the web there is no desktop application, so this module provides
# the same names over the board the collaborative editor holds: the board arrives as the text
# of its .kicad_pcb file, every object here is a view onto one node of that s-expression, and
# when the plugin returns, the items it touched go back to the editor as one ordinary
# collaborative edit (web/plugins/pyruntime.ts).  Lengths are KiCad's internal units
# (nanometres) on the Python side and millimetres in the file, exactly as on the desktop.
#
# What cannot exist in a browser — plotting to disk, loading other boards, the 3D model
# cache — says so with WebUnsupported when it is called, never at import time, so a plugin
# that only touches such a thing in one of its commands still loads and runs the others.

import math as _math
import copy as _copy
import logging as _logging
import re as _re
import sys as _sys
import uuid as _uuid

__version__ = "10.0.0"


class WebUnsupported(NotImplementedError):
    """Raised when a plugin asks for something the web editor cannot do."""


def _unsupported(what):
    raise WebUnsupported(f"{what} is not available in the web editor")


# ----------------------------------------------------------------------------- s-expressions

class Sym(str):
    """A bare token (a keyword or a number); plain str is a quoted string."""
    __slots__ = ()


_TOKEN = _re.compile(r'\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))')
_UNESC = _re.compile(r'\\(.)')
_ESC_MAP = {"n": "\n", "r": "\r", "t": "\t"}


_SCAN = _re.compile(r'[()]|"(?:[^"\\]|\\.)*"|[^\s()"]+')


def _parse(text):
    """Parse s-expression text into nested lists.  Returns the list of top-level nodes."""
    top = []
    stack = [top]
    cur = top
    for tok in _SCAN.findall(text):
        c = tok[0]
        if c == "(":
            node = []
            cur.append(node)
            stack.append(node)
            cur = node
        elif c == ")":
            if len(stack) > 1:
                stack.pop()
                cur = stack[-1]
        elif c == '"':
            s = tok[1:-1]
            if "\\" in s:
                s = _UNESC.sub(lambda mm: _ESC_MAP.get(mm.group(1), mm.group(1)), s)
            cur.append(s)
        else:
            cur.append(Sym(tok))
    return top


def _quote(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def _dump(node):
    if isinstance(node, list):
        return "(" + " ".join(_dump(c) for c in node) + ")"
    if isinstance(node, Sym):
        return str(node)
    if isinstance(node, str):
        return _quote(node)
    if isinstance(node, bool):
        return "yes" if node else "no"
    if isinstance(node, float):
        return _num(node)
    return str(node)


def _num(v):
    s = f"{float(v):.6f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def _kid(node, name):
    for c in node:
        if isinstance(c, list) and c and c[0] == name:
            return c
    return None


def _kids(node, name):
    return [c for c in node if isinstance(c, list) and c and c[0] == name]


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _set_kid(node, name, *values):
    """Replace (or append) the child `name` with the given atoms."""
    k = _kid(node, name)
    atoms = [Sym(name)] + [(_n(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v) for v in values]
    if k is None:
        node.append(atoms)
        return atoms
    k[:] = atoms
    return k


def _n(v):
    return Sym(_num(v))


def _drop_kid(node, name):
    node[:] = [c for c in node if not (isinstance(c, list) and c and c[0] == name)]


def _flag(node, name, default=False):
    """KiCad writes booleans as (name yes|no) or as a bare `name` token."""
    k = _kid(node, name)
    if k is not None:
        return len(k) < 2 or str(k[1]) in ("yes", "true")
    return any(isinstance(c, Sym) and c == name for c in node[1:]) or default


def _set_flag(node, name, on):
    node[:] = [c for c in node if not (isinstance(c, Sym) and c == name and c is not node[0])]
    _set_kid(node, name, Sym("yes" if on else "no"))


# ----------------------------------------------------------------------------- units and geometry

IU_PER_MM = 1000000
PCB_IU_PER_MM = IU_PER_MM
IU_PER_MILS = 25400.0


def FromMM(mm):
    if isinstance(mm, (tuple, list)):
        return tuple(FromMM(v) for v in mm)
    return int(round(float(mm) * IU_PER_MM))


def ToMM(iu):
    if isinstance(iu, VECTOR2I):
        return (iu.x / IU_PER_MM, iu.y / IU_PER_MM)
    if isinstance(iu, (tuple, list)):
        return tuple(ToMM(v) for v in iu)
    return float(iu) / IU_PER_MM


def FromMils(mils):
    return int(round(float(mils) * IU_PER_MILS))


def ToMils(iu):
    return float(iu) / IU_PER_MILS


def Millimeter2iu(mm):
    return FromMM(mm)


def Iu2Millimeter(iu):
    return ToMM(iu)


class _IuScale:
    IU_PER_MM = IU_PER_MM
    IU_PER_MILS = IU_PER_MILS
    MM_PER_IU = 1.0 / IU_PER_MM

    def mmToIU(self, mm):
        return FromMM(mm)

    def IUTomm(self, iu):
        return ToMM(iu)

    def MilsToIU(self, mils):
        return FromMils(mils)

    def IUToMils(self, iu):
        return ToMils(iu)


pcbIUScale = _IuScale()


class VECTOR2I:
    """A point or size in internal units.  Also answers to wxPoint and wxSize, as old plugins expect."""
    __slots__ = ("x", "y")

    def __init__(self, x=0, y=0):
        if isinstance(x, VECTOR2I):
            x, y = x.x, x.y
        elif isinstance(x, (tuple, list)):
            x, y = x[0], x[1]
        self.x = int(round(x))
        self.y = int(round(y))

    # wxSize spelling
    @property
    def width(self):
        return self.x

    @property
    def height(self):
        return self.y

    def GetWidth(self):
        return self.x

    def GetHeight(self):
        return self.y

    def Get(self):
        return (self.x, self.y)

    def Set(self, x, y):
        self.x, self.y = int(round(x)), int(round(y))

    def __iter__(self):
        yield self.x
        yield self.y

    def __getitem__(self, i):
        return (self.x, self.y)[i]

    def __len__(self):
        return 2

    def __eq__(self, o):
        try:
            return self.x == o[0] and self.y == o[1]
        except Exception:
            return False

    def __ne__(self, o):
        return not self.__eq__(o)

    def __hash__(self):
        return hash((self.x, self.y))

    def __add__(self, o):
        return VECTOR2I(self.x + o[0], self.y + o[1])

    __radd__ = __add__

    def __sub__(self, o):
        return VECTOR2I(self.x - o[0], self.y - o[1])

    def __rsub__(self, o):
        return VECTOR2I(o[0] - self.x, o[1] - self.y)

    def __neg__(self):
        return VECTOR2I(-self.x, -self.y)

    def __mul__(self, k):
        return VECTOR2I(self.x * k, self.y * k)

    __rmul__ = __mul__

    def __truediv__(self, k):
        return VECTOR2I(self.x / k, self.y / k)

    __floordiv__ = __truediv__

    def EuclideanNorm(self):
        return _math.hypot(self.x, self.y)

    def SquaredEuclideanNorm(self):
        return self.x * self.x + self.y * self.y

    def Distance(self, o):
        return _math.hypot(self.x - o[0], self.y - o[1])

    def Resize(self, length):
        n = self.EuclideanNorm()
        return VECTOR2I(self.x * length / n, self.y * length / n) if n else VECTOR2I(0, 0)

    def Perpendicular(self):
        return VECTOR2I(-self.y, self.x)

    def Dot(self, o):
        return self.x * o[0] + self.y * o[1]

    def Cross(self, o):
        return self.x * o[1] - self.y * o[0]

    def Angle(self):
        return _math.atan2(self.y, self.x)

    def __repr__(self):
        return f"VECTOR2I({self.x}, {self.y})"

    __str__ = __repr__


wxPoint = VECTOR2I
wxSize = VECTOR2I
VECTOR2L = VECTOR2I


class VECTOR2D(VECTOR2I):
    def __init__(self, x=0.0, y=0.0):
        if isinstance(x, (tuple, list, VECTOR2I)):
            x, y = x[0], x[1]
        object.__setattr__(self, "x", float(x))
        object.__setattr__(self, "y", float(y))


def VECTOR2I_MM(x, y):
    return VECTOR2I(FromMM(x), FromMM(y))


wxPointMM = VECTOR2I_MM
wxSizeMM = VECTOR2I_MM


def wxPointMils(x, y):
    return VECTOR2I(FromMils(x), FromMils(y))


wxSizeMils = wxPointMils
VECTOR2I_Mils = wxPointMils


class VECTOR3D:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = float(x), float(y), float(z)

    def __iter__(self):
        return iter((self.x, self.y, self.z))


DEGREES_T = 1
RADIANS_T = 2
TENTHS_OF_A_DEGREE_T = 0


class EDA_ANGLE:
    __slots__ = ("_deg",)

    def __init__(self, value=0.0, unit=DEGREES_T):
        if isinstance(value, EDA_ANGLE):
            self._deg = value._deg
        elif isinstance(value, VECTOR2I):
            self._deg = _math.degrees(_math.atan2(value.y, value.x))
        elif unit == RADIANS_T:
            self._deg = _math.degrees(value)
        elif unit == TENTHS_OF_A_DEGREE_T:
            self._deg = value / 10.0
        else:
            self._deg = float(value)

    def AsDegrees(self):
        return self._deg

    def AsTenthsOfADegree(self):
        return int(round(self._deg * 10))

    def AsRadians(self):
        return _math.radians(self._deg)

    def Normalize(self):
        self._deg = self._deg % 360.0
        return self

    def Normalize180(self):
        d = self._deg % 360.0
        self._deg = d - 360.0 if d > 180.0 else d
        return self

    def Normalized(self):
        return EDA_ANGLE(self._deg % 360.0)

    def Invert(self):
        return EDA_ANGLE(-self._deg)

    def IsZero(self):
        return self._deg % 360.0 == 0

    def IsCardinal(self):
        return self._deg % 90.0 == 0

    def Sin(self):
        return _math.sin(self.AsRadians())

    def Cos(self):
        return _math.cos(self.AsRadians())

    def Tan(self):
        return _math.tan(self.AsRadians())

    def __float__(self):
        return self._deg

    def __neg__(self):
        return EDA_ANGLE(-self._deg)

    def __add__(self, o):
        return EDA_ANGLE(self._deg + _deg(o))

    __radd__ = __add__

    def __sub__(self, o):
        return EDA_ANGLE(self._deg - _deg(o))

    def __mul__(self, k):
        return EDA_ANGLE(self._deg * k)

    __rmul__ = __mul__

    def __rsub__(self, o):
        return EDA_ANGLE(_deg(o) - self._deg)

    def __truediv__(self, k):
        return EDA_ANGLE(self._deg / k)

    def __eq__(self, o):
        return isinstance(o, (EDA_ANGLE, int, float)) and abs(self._deg - _deg(o)) < 1e-9

    def __lt__(self, o):
        return self._deg < _deg(o)

    def __le__(self, o):
        return self._deg <= _deg(o)

    def __gt__(self, o):
        return self._deg > _deg(o)

    def __ge__(self, o):
        return self._deg >= _deg(o)

    def __hash__(self):
        return hash(self._deg)

    def __repr__(self):
        return f"EDA_ANGLE({self._deg}, DEGREES_T)"

    def __format__(self, spec):
        return format(self._deg, spec)

    def __int__(self):
        return int(self._deg)

    def __abs__(self):
        return EDA_ANGLE(abs(self._deg))

    def __mod__(self, k):
        return EDA_ANGLE(self._deg % _deg(k))


def _deg(v):
    """Degrees out of an EDA_ANGLE or a bare number (which KiCad 6 plugins pass as tenths of a degree)."""
    if isinstance(v, EDA_ANGLE):
        return v._deg
    return float(v)


ANGLE_0 = EDA_ANGLE(0)
ANGLE_45 = EDA_ANGLE(45)
ANGLE_90 = EDA_ANGLE(90)
ANGLE_135 = EDA_ANGLE(135)
ANGLE_180 = EDA_ANGLE(180)
ANGLE_270 = EDA_ANGLE(270)
ANGLE_360 = EDA_ANGLE(360)
ANGLE_HORIZONTAL = ANGLE_0
ANGLE_VERTICAL = ANGLE_90


def _rot(x, y, deg):
    """Rotate (x, y) by `deg` the way KiCad draws it: positive is counter-clockwise on screen (y down)."""
    if not deg:
        return x, y
    a = _math.radians(deg)
    c, s = _math.cos(a), _math.sin(a)
    return x * c + y * s, -x * s + y * c


def RotatePoint(point, centre_or_angle, angle=None):
    if angle is None:
        x, y = _rot(point[0], point[1], _deg(centre_or_angle))
    else:
        x, y = _rot(point[0] - centre_or_angle[0], point[1] - centre_or_angle[1], _deg(angle))
        x, y = x + centre_or_angle[0], y + centre_or_angle[1]
    if isinstance(point, VECTOR2I):
        point.x, point.y = int(round(x)), int(round(y))
        return point
    return VECTOR2I(x, y)


class BOX2I:
    def __init__(self, origin=None, size=None):
        o = VECTOR2I(origin) if origin is not None else VECTOR2I(0, 0)
        s = VECTOR2I(size) if size is not None else VECTOR2I(0, 0)
        self._x, self._y, self._w, self._h = o.x, o.y, s.x, s.y
        self._valid = origin is not None

    @classmethod
    def _of(cls, x0, y0, x1, y1):
        b = cls(VECTOR2I(min(x0, x1), min(y0, y1)), VECTOR2I(abs(x1 - x0), abs(y1 - y0)))
        return b

    def getWxRect(self):
        """KiCad 6's EDA_RECT.getWxRect: x, y, width, height."""
        import wx
        _Host.kicad6 = True
        return wx.Rect(int(self._x), int(self._y), int(self._w), int(self._h))

    def GetX(self):
        return self._x

    def GetY(self):
        return self._y

    def GetWidth(self):
        return self._w

    def GetHeight(self):
        return self._h

    def GetLeft(self):
        return self._x

    def GetTop(self):
        return self._y

    def GetRight(self):
        return self._x + self._w

    def GetBottom(self):
        return self._y + self._h

    def GetOrigin(self):
        return VECTOR2I(self._x, self._y)

    GetPosition = GetOrigin

    def GetEnd(self):
        return VECTOR2I(self._x + self._w, self._y + self._h)

    def GetSize(self):
        return VECTOR2I(self._w, self._h)

    def GetCenter(self):
        return VECTOR2I(self._x + self._w / 2, self._y + self._h / 2)

    Centre = GetCenter

    def GetArea(self):
        return self._w * self._h

    def SetOrigin(self, *a):
        p = VECTOR2I(*a)
        self._x, self._y, self._valid = p.x, p.y, True

    def SetSize(self, *a):
        p = VECTOR2I(*a)
        self._w, self._h = p.x, p.y

    def SetEnd(self, *a):
        p = VECTOR2I(*a)
        self._w, self._h = p.x - self._x, p.y - self._y

    def SetX(self, v):
        self._x = int(v)

    def SetY(self, v):
        self._y = int(v)

    def SetWidth(self, v):
        self._w = int(v)

    def SetHeight(self, v):
        self._h = int(v)

    def Move(self, d):
        self._x += d[0]
        self._y += d[1]

    def Inflate(self, dx, dy=None):
        dy = dx if dy is None else dy
        self._x -= dx
        self._y -= dy
        self._w += 2 * dx
        self._h += 2 * dy
        return self

    def GetInflated(self, dx, dy=None):
        """A copy grown by this much on every side; this box is left as it is."""
        dy = dx if dy is None else dy
        b = BOX2I()
        b._x, b._y, b._w, b._h, b._valid = self._x - dx, self._y - dy, self._w + 2 * dx, self._h + 2 * dy, self._valid
        return b

    def Merge(self, o):
        if isinstance(o, BOX2I):
            if not o._valid:
                return self
            pts = [(o._x, o._y), (o._x + o._w, o._y + o._h)]
        else:
            pts = [(o[0], o[1])]
        if not self._valid:
            self._x, self._y, self._w, self._h, self._valid = pts[0][0], pts[0][1], 0, 0, True
        x0, y0, x1, y1 = self._x, self._y, self._x + self._w, self._y + self._h
        for px, py in pts:
            x0, y0, x1, y1 = min(x0, px), min(y0, py), max(x1, px), max(y1, py)
        self._x, self._y, self._w, self._h = x0, y0, x1 - x0, y1 - y0
        return self

    def Contains(self, *a):
        if len(a) == 1 and isinstance(a[0], BOX2I):
            o = a[0]
            return self._x <= o._x and self._y <= o._y and o._x + o._w <= self._x + self._w and o._y + o._h <= self._y + self._h
        p = VECTOR2I(*a)
        return self._x <= p.x <= self._x + self._w and self._y <= p.y <= self._y + self._h

    def Intersects(self, o):
        return not (o._x > self._x + self._w or o._x + o._w < self._x or o._y > self._y + self._h or o._y + o._h < self._y)

    def Normalize(self):
        if self._w < 0:
            self._x += self._w
            self._w = -self._w
        if self._h < 0:
            self._y += self._h
            self._h = -self._h
        return self

    def __repr__(self):
        return f"BOX2I(({self._x}, {self._y}), ({self._w}, {self._h}))"


# EDA_RECT, TRACK, MODULE and the like: see _LEGACY at the end of this file
wxRect = BOX2I


# ----------------------------------------------------------------------------- layers

UNDEFINED_LAYER = -1
UNSELECTED_LAYER = -2
F_Cu, B_Cu = 0, 2
F_Mask, B_Mask, F_SilkS, B_SilkS, F_Adhes, B_Adhes, F_Paste, B_Paste = 1, 3, 5, 7, 9, 11, 13, 15
Dwgs_User, Cmts_User, Eco1_User, Eco2_User, Edge_Cuts, Margin = 17, 19, 21, 23, 25, 27
B_CrtYd, F_CrtYd, B_Fab, F_Fab, Rescue = 29, 31, 33, 35, 37
PCB_LAYER_ID_COUNT = 128
MAX_CU_LAYERS = 32

_LAYER_NAMES = {
    F_Cu: "F.Cu", B_Cu: "B.Cu", F_Mask: "F.Mask", B_Mask: "B.Mask", F_SilkS: "F.SilkS", B_SilkS: "B.SilkS",
    F_Adhes: "F.Adhes", B_Adhes: "B.Adhes", F_Paste: "F.Paste", B_Paste: "B.Paste", Dwgs_User: "Dwgs.User",
    Cmts_User: "Cmts.User", Eco1_User: "Eco1.User", Eco2_User: "Eco2.User", Edge_Cuts: "Edge.Cuts", Margin: "Margin",
    B_CrtYd: "B.CrtYd", F_CrtYd: "F.CrtYd", B_Fab: "B.Fab", F_Fab: "F.Fab", Rescue: "Rescue",
}
_g = globals()
for _i in range(1, 31):
    _g[f"In{_i}_Cu"] = 2 + 2 * _i
    _LAYER_NAMES[2 + 2 * _i] = f"In{_i}.Cu"
for _i in range(1, 46):
    _g[f"User_{_i}"] = 37 + 2 * _i
    _LAYER_NAMES[37 + 2 * _i] = f"User.{_i}"
_LAYER_IDS = {v: k for k, v in _LAYER_NAMES.items()}
_LAYER_IDS.update({"F.Silkscreen": F_SilkS, "B.Silkscreen": B_SilkS, "F.Courtyard": F_CrtYd, "B.Courtyard": B_CrtYd,
                   "F.Adhesive": F_Adhes, "B.Adhesive": B_Adhes, "User.Drawings": Dwgs_User, "User.Comments": Cmts_User,
                   "User.Eco1": Eco1_User, "User.Eco2": Eco2_User})
# names KiCad's Python binding also exports
F_Silkscreen, B_Silkscreen, F_Courtyard, B_Courtyard = F_SilkS, B_SilkS, F_CrtYd, B_CrtYd
_FLIP = {F_Cu: B_Cu, F_Mask: B_Mask, F_SilkS: B_SilkS, F_Adhes: B_Adhes, F_Paste: B_Paste, F_CrtYd: B_CrtYd, F_Fab: B_Fab}
_FLIP.update({v: k for k, v in _FLIP.items()})


# LayerName() of KiCad 6 and later: what BOARD::GetStandardLayerName and GetLayerName answer (the file keeps the short names)
_UI_NAMES = {F_SilkS: "F.Silkscreen", B_SilkS: "B.Silkscreen", F_CrtYd: "F.Courtyard", B_CrtYd: "B.Courtyard", F_Adhes: "F.Adhesive",
             B_Adhes: "B.Adhesive", Dwgs_User: "User.Drawings", Cmts_User: "User.Comments", Eco1_User: "User.Eco1", Eco2_User: "User.Eco2"}


def _ui_layer_name(layer):
    return _UI_NAMES.get(int(layer), None) or _layer_name(layer)


def _layer_id(name):
    if isinstance(name, int):
        return name
    return _LAYER_IDS.get(str(name), UNDEFINED_LAYER)


def _layer_name(layer):
    if isinstance(layer, str):
        return layer
    return _LAYER_NAMES.get(int(layer), "")


def IsCopperLayer(layer, *_):
    return 0 <= int(layer) <= 62 and int(layer) % 2 == 0


def IsFrontLayer(layer):
    return int(layer) in (F_Cu, F_Mask, F_SilkS, F_Adhes, F_Paste, F_CrtYd, F_Fab)


def IsBackLayer(layer):
    return int(layer) in (B_Cu, B_Mask, B_SilkS, B_Adhes, B_Paste, B_CrtYd, B_Fab)


def IsNonCopperLayer(layer):
    return not IsCopperLayer(layer)


def IsUserLayer(layer):
    return int(layer) in (Dwgs_User, Cmts_User, Eco1_User, Eco2_User) or int(layer) >= 39


def IsInnerCopperLayer(layer):
    return IsCopperLayer(layer) and int(layer) not in (F_Cu, B_Cu)


def FlipLayer(layer, copper_count=0):
    return _FLIP.get(int(layer), int(layer))


def ToLAYER_ID(layer):
    return int(layer)


def LayerName(layer):
    return _layer_name(layer)


_CU_ORDER = [F_Cu] + [2 + 2 * i for i in range(1, 31)] + [B_Cu]


class LSET:
    """A set of layers."""

    def __init__(self, *layers):
        self._s = set()
        for l in layers:
            if isinstance(l, LSET):
                self._s |= l._s
            elif isinstance(l, (list, tuple, set, frozenset)):
                self._s |= {int(x) for x in l}
            elif l is not None:
                self._s.add(int(l))

    @classmethod
    def _from_names(cls, names, copper_layers=None):
        out = cls()
        for n in names:
            n = str(n)
            if n.startswith("*."):
                tail = n[1:]
                if tail == ".Cu":
                    out._s |= set(copper_layers if copper_layers is not None else _CU_ORDER)
                else:
                    out._s |= {i for nm, i in _LAYER_IDS.items() if nm in ("F" + tail, "B" + tail)}
            elif n == "F&B.Cu":
                out._s |= {F_Cu, B_Cu}
            elif n in _LAYER_IDS:
                out._s.add(_LAYER_IDS[n])
        return out

    def _names(self):
        return [_layer_name(l) for l in self.Seq()]

    def AddLayer(self, layer):
        self._s.add(int(layer))
        return self

    addLayer = AddLayer

    def AddLayerSet(self, other):
        self._s |= LSET(other)._s
        return self

    addLayerSet = AddLayerSet

    def RemoveLayer(self, layer):
        self._s.discard(int(layer))
        return self

    removeLayer = RemoveLayer

    def RemoveLayerSet(self, other):
        self._s -= LSET(other)._s
        return self

    removeLayerSet = RemoveLayerSet

    def Contains(self, layer):
        return int(layer) in self._s

    def set(self, layer=None, value=True):
        if layer is None:
            self._s = set(range(PCB_LAYER_ID_COUNT))
        elif value:
            self._s.add(int(layer))
        else:
            self._s.discard(int(layer))
        return self

    def reset(self, layer=None):
        if layer is None:
            self._s.clear()
        else:
            self._s.discard(int(layer))
        return self

    def test(self, layer):
        return int(layer) in self._s

    def any(self):
        return bool(self._s)

    def none(self):
        return not self._s

    def count(self):
        return len(self._s)

    def size(self):
        return PCB_LAYER_ID_COUNT

    def Seq(self, order=None, *_):
        """The layers in the order given, or by layer number as KiCad does (F.Cu 0, F.Mask 1, B.Cu 2, …)."""
        if order is not None and not isinstance(order, (int, bool)):
            try:
                return [int(l) for l in order if int(l) in self._s]
            except TypeError:
                pass
        return sorted(self._s)

    def _stack_order(self, *_):
        cu = [l for l in _CU_ORDER if l in self._s]
        return cu + sorted(l for l in self._s if l not in cu)

    SeqStackupForPlotting = _stack_order
    SeqStackupTop2Bottom = _stack_order
    UIOrder = _stack_order
    CuStack = lambda self, *_: [l for l in _CU_ORDER if l in self._s]

    def Technicals(self, *_):
        return [l for l in self.Seq() if not IsCopperLayer(l) and not IsUserLayer(l)]

    def Users(self):
        return [l for l in self.Seq() if IsUserLayer(l)]

    def FmtHex(self):
        return "%x" % sum(1 << l for l in self._s)

    def FmtBin(self):
        return bin(sum(1 << l for l in self._s))[2:]

    def __iter__(self):
        return iter(self.Seq())

    def __len__(self):
        return len(self._s)

    def __contains__(self, layer):
        return int(layer) in self._s

    def __or__(self, o):
        return LSET(self._s | LSET(o)._s)

    def __and__(self, o):
        return LSET(self._s & LSET(o)._s)

    def __sub__(self, o):
        return LSET(self._s - LSET(o)._s)

    def __xor__(self, o):
        return LSET(self._s ^ LSET(o)._s)

    def __invert__(self):
        return LSET(set(range(PCB_LAYER_ID_COUNT)) - self._s)

    def __eq__(self, o):
        return isinstance(o, LSET) and self._s == o._s

    def __hash__(self):
        return hash(frozenset(self._s))

    def __bool__(self):
        return bool(self._s)

    def __repr__(self):
        return "LSET(" + ", ".join(self._names()) + ")"

    @staticmethod
    def Name(layer):
        return _layer_name(layer)

    @staticmethod
    def NameToLayer(name):
        return _layer_id(name)

    @staticmethod
    def AllCuMask(count=MAX_CU_LAYERS):
        count = max(2, int(count))
        return LSET(_CU_ORDER[:count - 1] + [B_Cu])

    @staticmethod
    def ExternalCuMask():
        return LSET(F_Cu, B_Cu)

    @staticmethod
    def InternalCuMask():
        return LSET(_CU_ORDER[1:-1])

    @staticmethod
    def AllNonCuMask():
        return LSET([l for l in _LAYER_NAMES if not IsCopperLayer(l)])

    @staticmethod
    def AllLayersMask():
        return LSET(list(_LAYER_NAMES))

    @staticmethod
    def FrontTechMask():
        return LSET(F_SilkS, F_Mask, F_Adhes, F_Paste, F_CrtYd, F_Fab)

    @staticmethod
    def BackTechMask():
        return LSET(B_SilkS, B_Mask, B_Adhes, B_Paste, B_CrtYd, B_Fab)

    @staticmethod
    def AllTechMask():
        return LSET.FrontTechMask() | LSET.BackTechMask()

    @staticmethod
    def AllBoardTechMask():
        return LSET(F_SilkS, F_Mask, F_Adhes, F_Paste, B_SilkS, B_Mask, B_Adhes, B_Paste)

    @staticmethod
    def FrontMask():
        return LSET.FrontTechMask() | LSET(F_Cu)

    @staticmethod
    def BackMask():
        return LSET.BackTechMask() | LSET(B_Cu)

    @staticmethod
    def FrontBoardTechMask():
        return LSET(F_SilkS, F_Mask, F_Adhes, F_Paste)

    @staticmethod
    def BackBoardTechMask():
        return LSET(B_SilkS, B_Mask, B_Adhes, B_Paste)

    @staticmethod
    def UserMask():
        return LSET(Dwgs_User, Cmts_User, Eco1_User, Eco2_User, Edge_Cuts, Margin)

    @staticmethod
    def PhysicalLayersMask():
        return LSET.AllBoardTechMask() | LSET.AllCuMask()

    @staticmethod
    def UserDefinedLayers():
        return LSET([37 + 2 * i for i in range(1, 46)])

    @staticmethod
    def SideSpecificMask():
        return LSET.FrontTechMask() | LSET.BackTechMask() | LSET.ExternalCuMask()


def FlipLayerMask(mask, copper_count=0):
    return LSET([FlipLayer(l) for l in LSET(mask)._s])


# ----------------------------------------------------------------------------- constants

# item types (include/core/typeinfo.h)
(NOT_USED, TYPE_NOT_INIT, PCB_T, SCREEN_T, PCB_FOOTPRINT_T, PCB_PAD_T, PCB_SHAPE_T, PCB_REFERENCE_IMAGE_T, PCB_FIELD_T,
 PCB_GENERATOR_T, PCB_TEXT_T, PCB_TEXTBOX_T, PCB_TABLE_T, PCB_TABLECELL_T, PCB_TRACE_T, PCB_VIA_T, PCB_ARC_T, PCB_MARKER_T,
 PCB_DIMENSION_T, PCB_BARCODE_T, PCB_DIM_ALIGNED_T, PCB_DIM_LEADER_T, PCB_DIM_CENTER_T, PCB_DIM_RADIAL_T,
 PCB_DIM_ORTHOGONAL_T, PCB_TARGET_T, PCB_ZONE_T, PCB_ITEM_LIST_T, PCB_NETINFO_T, PCB_GROUP_T, PCB_BOARD_OUTLINE_T,
 PCB_POINT_T) = range(-1, 31)
PCB_FP_TEXT_T, PCB_FP_SHAPE_T, PCB_FP_ZONE_T = PCB_TEXT_T, PCB_SHAPE_T, PCB_ZONE_T

PAD_ATTRIB_PTH, PAD_ATTRIB_SMD, PAD_ATTRIB_CONN, PAD_ATTRIB_NPTH = 0, 1, 2, 3
CUST_PAD_SHAPE_IN_ZONE_OUTLINE, CUST_PAD_SHAPE_IN_ZONE_CONVEXHULL = 0, 1
PAD_ATTRIB_STANDARD, PAD_ATTRIB_HOLE_NOT_PLATED = PAD_ATTRIB_PTH, PAD_ATTRIB_NPTH
(PAD_SHAPE_CIRCLE, PAD_SHAPE_RECTANGLE, PAD_SHAPE_OVAL, PAD_SHAPE_TRAPEZOID, PAD_SHAPE_ROUNDRECT,
 PAD_SHAPE_CHAMFERED_RECT, PAD_SHAPE_CUSTOM) = range(7)
PAD_SHAPE_RECT = PAD_SHAPE_RECTANGLE
PAD_DRILL_SHAPE_UNDEFINED, PAD_DRILL_SHAPE_CIRCLE, PAD_DRILL_SHAPE_OBLONG = 0, 1, 2
(PAD_PROP_NONE, PAD_PROP_BGA, PAD_PROP_FIDUCIAL_GLBL, PAD_PROP_FIDUCIAL_LOCAL, PAD_PROP_TESTPOINT, PAD_PROP_HEATSINK,
 PAD_PROP_CASTELLATED, PAD_PROP_MECHANICAL) = range(8)
FP_THROUGH_HOLE, FP_SMD, FP_EXCLUDE_FROM_POS_FILES, FP_EXCLUDE_FROM_BOM, FP_BOARD_ONLY, FP_JUST_ADDED, FP_ALLOW_SOLDERMASK_BRIDGES, FP_ALLOW_MISSING_COURTYARD, FP_DNP = (
    0x0001, 0x0002, 0x0004, 0x0008, 0x0010, 0x0020, 0x0040, 0x0080, 0x0100)
VIATYPE_THROUGH, VIATYPE_BLIND_BURIED, VIATYPE_MICROVIA, VIATYPE_NOT_DEFINED = 3, 2, 1, 0
VIATYPE_BLIND, VIATYPE_BURIED = 4, 5
(SHAPE_T_UNDEFINED, SHAPE_T_SEGMENT, SHAPE_T_RECTANGLE, SHAPE_T_ARC, SHAPE_T_CIRCLE, SHAPE_T_POLY, SHAPE_T_BEZIER) = range(-1, 6)
SHAPE_T_RECT = SHAPE_T_RECTANGLE
S_SEGMENT, S_RECT, S_ARC, S_CIRCLE, S_POLYGON, S_CURVE = SHAPE_T_SEGMENT, SHAPE_T_RECTANGLE, SHAPE_T_ARC, SHAPE_T_CIRCLE, SHAPE_T_POLY, SHAPE_T_BEZIER
GR_TEXT_H_ALIGN_LEFT, GR_TEXT_H_ALIGN_CENTER, GR_TEXT_H_ALIGN_RIGHT, GR_TEXT_H_ALIGN_INDETERMINATE = -1, 0, 1, 2
GR_TEXT_V_ALIGN_TOP, GR_TEXT_V_ALIGN_CENTER, GR_TEXT_V_ALIGN_BOTTOM, GR_TEXT_V_ALIGN_INDETERMINATE = -1, 0, 1, 2
GR_TEXT_HJUSTIFY_LEFT, GR_TEXT_HJUSTIFY_CENTER, GR_TEXT_HJUSTIFY_RIGHT = -1, 0, 1
GR_TEXT_VJUSTIFY_TOP, GR_TEXT_VJUSTIFY_CENTER, GR_TEXT_VJUSTIFY_BOTTOM = -1, 0, 1
(ZONE_CONNECTION_INHERITED, ZONE_CONNECTION_NONE, ZONE_CONNECTION_THERMAL, ZONE_CONNECTION_FULL,
 ZONE_CONNECTION_THT_THERMAL) = -1, 0, 1, 2, 3
ZONE_FILL_MODE_POLYGONS, ZONE_FILL_MODE_HATCH_PATTERN = 0, 1
ZONE_BORDER_DISPLAY_STYLE_NO_HATCH, ZONE_BORDER_DISPLAY_STYLE_DIAGONAL_FULL, ZONE_BORDER_DISPLAY_STYLE_DIAGONAL_EDGE = 0, 1, 2
ISLAND_REMOVAL_MODE_ALWAYS, ISLAND_REMOVAL_MODE_NEVER, ISLAND_REMOVAL_MODE_AREA = 0, 1, 2
(PLOT_FORMAT_UNDEFINED, PLOT_FORMAT_HPGL, PLOT_FORMAT_GERBER, PLOT_FORMAT_POST, PLOT_FORMAT_DXF, PLOT_FORMAT_PDF,
 PLOT_FORMAT_SVG) = -1, 0, 1, 2, 3, 4, 5
DRILL_MARKS_NO_DRILL_SHAPE, DRILL_MARKS_SMALL_DRILL_SHAPE, DRILL_MARKS_FULL_DRILL_SHAPE = 0, 1, 2
PCB_PLOT_PARAMS_NO_DRILL_SHAPE, PCB_PLOT_PARAMS_SMALL_DRILL_SHAPE, PCB_PLOT_PARAMS_FULL_DRILL_SHAPE = 0, 1, 2
PLOT_TEXT_MODE_STROKE, PLOT_TEXT_MODE_NATIVE, PLOT_TEXT_MODE_PHANTOM, PLOT_TEXT_MODE_DEFAULT = 0, 1, 2, 3
EDA_UNITS_INCHES, EDA_UNITS_MILLIMETRES, EDA_UNITS_UNSCALED, EDA_UNITS_DEGREES, EDA_UNITS_PERCENT, EDA_UNITS_MILS = 0, 1, 2, 3, 4, 5
EDA_UNITS_INCH, EDA_UNITS_MM = EDA_UNITS_INCHES, EDA_UNITS_MILLIMETRES
DIM_UNITS_MODE_INCHES, DIM_UNITS_MODE_MILS, DIM_UNITS_MODE_MILLIMETRES, DIM_UNITS_MODE_AUTOMATIC = 0, 1, 2, 3
DIM_UNITS_MODE_INCH, DIM_UNITS_MODE_MM = DIM_UNITS_MODE_INCHES, DIM_UNITS_MODE_MILLIMETRES
DXF_UNITS_INCHES, DXF_UNITS_MILLIMETERS = 0, 1
DXF_UNITS_INCH, DXF_UNITS_MM = DXF_UNITS_INCHES, DXF_UNITS_MILLIMETERS
NETINFO_LIST_UNCONNECTED, NETINFO_LIST_ORPHANED = 0, -1
RECURSE, NO_RECURSE = 0, 1
ADD_MODE_INSERT, ADD_MODE_APPEND, ADD_MODE_BULK_APPEND, ADD_MODE_BULK_INSERT = 0, 1, 2, 3
REMOVE_MODE_NORMAL, REMOVE_MODE_BULK = 0, 1
RPT_SEVERITY_UNDEFINED, RPT_SEVERITY_INFO, RPT_SEVERITY_EXCLUSION, RPT_SEVERITY_ACTION, RPT_SEVERITY_WARNING, RPT_SEVERITY_ERROR, RPT_SEVERITY_IGNORE = 0, 1, 2, 4, 8, 16, 32
SELECTED, BRIGHTENED, IS_NEW, IS_CHANGED, IS_MOVING = 1 << 3, 1 << 5, 1 << 0, 1 << 1, 1 << 2
B_Courtyard_layer = B_CrtYd
LAYER_CLASS_SILK, LAYER_CLASS_COPPER, LAYER_CLASS_EDGES, LAYER_CLASS_COURTYARD, LAYER_CLASS_FAB, LAYER_CLASS_OTHERS, LAYER_CLASS_COUNT = range(7)
ERROR_OUTSIDE, ERROR_INSIDE = 0, 1
CORNER_STRATEGY_ALLOW_ACUTE_CORNERS, CORNER_STRATEGY_CHAMFER_ACUTE_CORNERS, CORNER_STRATEGY_ROUND_ACUTE_CORNERS, CORNER_STRATEGY_CHAMFER_ALL_CORNERS, CORNER_STRATEGY_ROUND_ALL_CORNERS = range(5)

_PAD_ATTR = {"thru_hole": PAD_ATTRIB_PTH, "smd": PAD_ATTRIB_SMD, "connect": PAD_ATTRIB_CONN, "np_thru_hole": PAD_ATTRIB_NPTH}
_PAD_SHAPE = {"circle": PAD_SHAPE_CIRCLE, "rect": PAD_SHAPE_RECTANGLE, "oval": PAD_SHAPE_OVAL, "trapezoid": PAD_SHAPE_TRAPEZOID,
              "roundrect": PAD_SHAPE_ROUNDRECT, "custom": PAD_SHAPE_CUSTOM}
_H_ALIGN = {"left": GR_TEXT_H_ALIGN_LEFT, "right": GR_TEXT_H_ALIGN_RIGHT}
_V_ALIGN = {"top": GR_TEXT_V_ALIGN_TOP, "bottom": GR_TEXT_V_ALIGN_BOTTOM}


# ----------------------------------------------------------------------------- identifiers

class KIID:
    def __init__(self, value=None):
        self._s = str(value) if value else str(_uuid.uuid4())

    def AsString(self):
        return self._s

    AsLegacyTimestampString = AsString

    def AsLegacyTimestamp(self):
        return 0

    def Hash(self):
        return hash(self._s)

    def IsLegacyTimestamp(self):
        return False

    def __str__(self):
        return self._s

    def __repr__(self):
        return f"KIID({self._s!r})"

    def __eq__(self, o):
        return str(o) == self._s

    def __hash__(self):
        return hash(self._s)

    def __lt__(self, o):
        return self._s < str(o)


niluuid = KIID("00000000-0000-0000-0000-000000000000")


class KIID_PATH(list):
    def __init__(self, path=""):
        super().__init__(KIID(p) for p in str(path).split("/") if p)

    def AsString(self):
        return "/" + "/".join(str(k) for k in self) if len(self) else ""

    def __str__(self):
        return self.AsString()

    def __hash__(self):
        return hash(self.AsString())


class LIB_ID:
    def __init__(self, a="", b=None):
        if b is None:
            a = str(a)
            self._lib, _, self._item = a.rpartition(":") if ":" in a else ("", "", a)
        else:
            self._lib, self._item = str(a), str(b)

    def GetLibNickname(self):
        return self._lib

    def GetLibItemName(self):
        return self._item

    def GetUniStringLibNickname(self):
        return self._lib

    def GetUniStringLibItemName(self):
        return self._item

    def GetUniStringLibId(self):
        return self.Format()

    def SetLibNickname(self, v):
        self._lib = str(v)

    def SetLibItemName(self, v, *_):
        self._item = str(v)

    def Format(self, *_):
        return f"{self._lib}:{self._item}" if self._lib else self._item

    def IsValid(self):
        return bool(self._item)

    def empty(self):
        return not self._item

    def __str__(self):
        return self.Format()


FPID = LIB_ID


class UTF8(str):
    def GetChars(self):
        return str(self)

    def wx_str(self):
        return str(self)


class wxString(str):
    pass


# ----------------------------------------------------------------------------- board items

class EDA_ITEM:
    _TYPE = NOT_USED
    _CLASS = "EDA_ITEM"

    def Type(self):
        return self._TYPE

    def GetClass(self):
        return self._CLASS

    def GetTypeDesc(self):
        return self._CLASS

    def Cast(self):
        return self

    def IsType(self, types):
        return self._TYPE in types


class BOARD_ITEM(EDA_ITEM):
    """A view onto one s-expression node of the board (or of a footprint on it)."""
    _TOKEN = None           # the keyword a newly created item of this class gets

    def __init__(self, parent=None, *_args):
        self._board = None
        self._parent = None         # the FOOTPRINT, for items inside one
        self._node = [Sym(self._TOKEN or "item")]
        self._dirty = False
        self._flags = 0
        self._selected = False
        if isinstance(parent, BOARD_ITEM) and not isinstance(parent, FOOTPRINT) and isinstance(parent, type(self)):
            # PCB_TRACK(track): a copy of the item, as the desktop's copy constructor makes; it gets its own id
            # because two items of one board cannot share one here
            self._node = _clone(parent._node)
            self._board = parent._board
            _set_kid(self._node, "uuid", str(_uuid.uuid4()))
            self._flags = IS_NEW
            return
        if isinstance(parent, BOARD):
            self._board = parent
        elif isinstance(parent, FOOTPRINT):
            self._parent = parent
            self._board = parent._board
        self._init_new()

    def _init_new(self):
        _set_kid(self._node, "uuid", str(_uuid.uuid4()))

    @classmethod
    def _wrap(cls, node, board, parent=None):
        self = cls.__new__(cls)
        self._board, self._parent, self._node = board, parent, node
        self._dirty, self._flags, self._selected = False, 0, False
        return self

    # -- change tracking
    def _touch(self):
        top = self._parent if self._parent is not None else self
        top._dirty = True
        if self._board is not None:
            self._board._modified = True

    def _offset(self):
        """What turns a stored coordinate into a board coordinate: (footprint x, y, rotation) in mm, or None."""
        p = self._parent
        return p._placement() if p is not None else None

    def _to_board(self, x, y):
        o = self._offset()
        if o is None:
            return x, y
        rx, ry = _rot(x, y, o[2])
        return rx + o[0], ry + o[1]

    def _to_local(self, x, y):
        o = self._offset()
        if o is None:
            return x, y
        return _rot(x - o[0], y - o[1], -o[2])

    def _pt(self, name, default=(0.0, 0.0)):
        k = _kid(self._node, name)
        if k is None or len(k) < 3:
            x, y = default
        else:
            x, y = _f(k[1]), _f(k[2])
        x, y = self._to_board(x, y)
        return VECTOR2I(FromMM(x), FromMM(y))

    def _set_pt(self, name, *a):
        p = VECTOR2I(*a)
        x, y = self._to_local(ToMM(p.x), ToMM(p.y))
        k = _kid(self._node, name)
        rest = k[3:] if k is not None else []
        _set_kid(self._node, name, x, y)
        if rest:
            _kid(self._node, name).extend(rest)
        self._touch()

    # -- identity
    @property
    def m_Uuid(self):
        k = _kid(self._node, "uuid") or _kid(self._node, "tstamp")
        return KIID(k[1]) if k is not None and len(k) > 1 else KIID()

    def GetParent(self):
        return self._parent if self._parent is not None else self._board

    def GetParentAsString(self):
        # KiCad: the footprint's reference when the parent is a footprint, else the parent's id
        p = self.GetParent()
        if isinstance(p, FOOTPRINT):
            return p.GetReference()
        m = getattr(p, "m_Uuid", None)
        return m.AsString() if m is not None else ""

    def GetParentFootprint(self):
        return self._parent

    def GetParentGroup(self):
        b = self._board
        if b is None:
            return None
        me = self.m_Uuid.AsString()
        for g in b.Groups():
            if me in g._member_ids():
                return g
        return None

    def SetParentGroup(self, group):
        current = self.GetParentGroup()
        if current is group:
            return
        if current is not None:
            current.RemoveItem(self)
        if group is not None:
            group.AddItem(self)

    def SetParent(self, parent):
        if isinstance(parent, FOOTPRINT):
            self._parent, self._board = parent, parent._board
        elif isinstance(parent, BOARD):
            self._board = parent

    def GetBoard(self):
        return self._board

    def IsLocked(self):
        return _flag(self._node, "locked")

    def SetLocked(self, on):
        _set_flag(self._node, "locked", bool(on))
        self._touch()

    # -- selection and flags
    def IsSelected(self):
        return self._selected

    def SetSelected(self):
        self._selected = True
        if self._board is not None:
            self._board._selection_changed = True

    def ClearSelected(self):
        self._selected = False
        if self._board is not None:
            self._board._selection_changed = True

    def SetBrightened(self):
        self._flags |= BRIGHTENED

    def ClearBrightened(self):
        self._flags &= ~BRIGHTENED

    def IsBrightened(self):
        return bool(self._flags & BRIGHTENED)

    def SetFlags(self, f):
        self._flags |= f

    def ClearFlags(self, f=0xFFFFFFFF):
        self._flags &= ~f

    def GetFlags(self):
        return self._flags

    def HasFlag(self, f):
        return bool(self._flags & f)

    def IsNew(self):
        return bool(self._flags & IS_NEW)

    def IsMoving(self):
        return False

    def SetModified(self):
        self._touch()

    def IsModified(self):
        return self._dirty

    # -- layer
    def GetLayer(self):
        k = _kid(self._node, "layer")
        return _layer_id(k[1]) if k is not None and len(k) > 1 else UNDEFINED_LAYER

    def SetLayer(self, layer):
        _set_kid(self._node, "layer", _layer_name(layer))
        self._touch()

    def GetLayerName(self):
        k = _kid(self._node, "layer")
        name = str(k[1]) if k is not None and len(k) > 1 else ""
        return self._board.GetLayerName(_layer_id(name)) if self._board is not None and name else name

    def GetLayerSet(self):
        return LSET(self.GetLayer())

    def SetLayerSet(self, lset):
        seq = LSET(lset).Seq()
        if seq:
            self.SetLayer(seq[0])

    def IsOnLayer(self, layer, *_):
        return int(layer) in self.GetLayerSet()._s

    def IsOnCopperLayer(self):
        return any(IsCopperLayer(l) for l in self.GetLayerSet()._s)

    def IsFlipped(self):
        return IsBackLayer(self.GetLayer())

    def IsConnected(self):
        return False

    def IsTented(self, *_):
        return False

    # -- geometry
    def GetPosition(self):
        return self._pt("at")

    def SetPosition(self, *a):
        self._set_pt("at", *a)

    def GetX(self):
        return self.GetPosition().x

    def GetY(self):
        return self.GetPosition().y

    def SetX(self, x):
        self.SetPosition(VECTOR2I(x, self.GetPosition().y))

    def SetY(self, y):
        self.SetPosition(VECTOR2I(self.GetPosition().x, y))

    def GetCenter(self):
        return self.GetBoundingBox().GetCenter()

    def GetFocusPosition(self):
        return self.GetPosition()

    def Move(self, *a):
        d = VECTOR2I(*a)
        self.SetPosition(self.GetPosition() + d)

    def Rotate(self, centre, angle):
        p = RotatePoint(VECTOR2I(self.GetPosition()), centre, angle)
        self.SetPosition(p)

    def Flip(self, centre, *_):
        p = self.GetPosition()
        self.SetPosition(VECTOR2I(p.x, 2 * VECTOR2I(centre).y - p.y))
        self.SetLayer(FlipLayer(self.GetLayer()))

    def GetBoundingBox(self, *_):
        p = self.GetPosition()
        return BOX2I(p, VECTOR2I(0, 0))

    def HitTest(self, pos, accuracy=0, *_):
        b = self.GetBoundingBox()
        if isinstance(pos, BOX2I):
            return pos.Intersects(b)
        return BOX2I(b.GetOrigin(), b.GetSize()).Inflate(accuracy).Contains(pos)

    def GetEffectiveShape(self, *_):
        _unsupported("GetEffectiveShape")

    def Duplicate(self, *_):
        node = _clone(self._node)
        _set_kid(node, "uuid", str(_uuid.uuid4()))
        if isinstance(self, FOOTPRINT):
            for c in node:
                if isinstance(c, list) and _kid(c, "uuid") is not None and c is not _kid(node, "uuid"):
                    _set_kid(c, "uuid", str(_uuid.uuid4()))
        dup = type(self)._wrap(node, None, None)
        dup._flags = IS_NEW
        if isinstance(dup, FOOTPRINT):
            dup._pending = dict(self._pending) if getattr(self, "_pending", None) else None
            dup._kids_cache = None
        return dup

    def DeleteStructure(self):
        if self._board is not None:
            self._board.Remove(self)

    def GetFriendlyName(self):
        return self._CLASS

    def GetItemDescription(self, *_):
        return self._CLASS

    def GetSelectMenuText(self, *_):
        return self._CLASS

    def ViewGetLayers(self):
        return [self.GetLayer()]

    def __eq__(self, o):
        return isinstance(o, BOARD_ITEM) and o._node is self._node

    def __hash__(self):
        return id(self._node)

    def __repr__(self):
        return f"<{self._CLASS} {self.m_Uuid.AsString()}>"


def _clone(node):
    if isinstance(node, list):
        return [_clone(c) for c in node]
    return node


class BOARD_CONNECTED_ITEM(BOARD_ITEM):
    def _net_name(self):
        if self._board is None and self.__dict__.get("_net_wanted") is not None:
            return self._net_wanted          # set on an item that is not on a board yet
        k = _kid(self._node, "net")
        if k is None or len(k) < 2:
            return ""
        if len(k) > 2:
            return str(k[2])
        if isinstance(k[1], Sym):
            b = self._board
            return b._net_names.get(int(_f(k[1])), "") if b is not None else ""
        return str(k[1])

    def GetNetname(self):
        return self._net_name()

    GetShortNetname = lambda self: self._net_name().rsplit("/", 1)[-1]
    GetDisplayNetname = GetNetname
    GetUnescapedShortNetname = GetShortNetname

    def GetNetCode(self):
        b = self._board
        return b._net_code(self._net_name()) if b is not None else 0

    def GetNet(self):
        b = self._board
        return b._net_item(self._net_name()) if b is not None else NETINFO_ITEM(None, self._net_name(), 0)

    def SetNet(self, net):
        self._write_net(net.GetNetname() if net is not None else "")

    def SetNetCode(self, code, *_):
        b = self._board
        if b is None:                        # not on a board yet: keep the number as given
            _set_kid(self._node, "net", int(code))
            self._net_wanted = None
            return True
        self._write_net(b._net_names.get(int(code), ""))
        return True

    def _write_net(self, name):
        b = self._board
        if b is None:                        # no board yet to give the net its number: written when the item is added
            self._net_wanted = str(name)
            if isinstance(self, PAD) and self._parent is not None:
                # a pad of a footprint that is not on a board yet: the name is kept in the pad itself, because the
                # footprint hands out new pad objects whenever it is moved or turned before it is added
                if name:
                    _set_kid(self._node, "net", str(name))
                else:
                    _drop_kid(self._node, "net")
            return
        self._net_wanted = None
        old = _kid(self._node, "net")
        by_name = (b is not None and b._nets_by_name_only) or (old is not None and len(old) == 2 and not isinstance(old[1], Sym))
        if by_name:
            if name:
                _set_kid(self._node, "net", name)
            else:
                _drop_kid(self._node, "net")
        else:
            code = b._net_code(name, create=True) if b is not None else 0
            if isinstance(self, PAD) or (old is not None and len(old) > 2):
                k = _set_kid(self._node, "net", code)
                k.append(name)
            else:
                _set_kid(self._node, "net", code)
        self._touch()

    def GetNetClassName(self):
        return _netclass_name(self.GetNetname())

    def GetNetClass(self):
        return _netclasses()[_netclass_name(self.GetNetname())]

    GetEffectiveNetClass = GetNetClass

    def IsConnected(self):
        return True

    def GetOwnClearance(self, *_):
        return FromMM(0.2)

    def GetLocalClearance(self, *_):
        k = _kid(self._node, "clearance")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    def SetLocalClearance(self, v):
        if v:
            _set_kid(self._node, "clearance", ToMM(v))
        else:
            _drop_kid(self._node, "clearance")
        self._touch()


class PCB_TRACK(BOARD_CONNECTED_ITEM):
    _TYPE, _CLASS, _TOKEN = PCB_TRACE_T, "PCB_TRACK", "segment"

    def _init_new(self):
        n = self._node
        n.extend([[Sym("start"), _n(0), _n(0)], [Sym("end"), _n(0), _n(0)], [Sym("width"), _n(0.25)], [Sym("layer"), "F.Cu"]])
        super()._init_new()

    def GetStart(self):
        return self._pt("start")

    def SetStart(self, *a):
        self._set_pt("start", *a)

    def GetEnd(self):
        return self._pt("end")

    def SetEnd(self, *a):
        self._set_pt("end", *a)

    def GetPosition(self):
        return self.GetStart()

    def SetPosition(self, *a):
        d = VECTOR2I(*a) - self.GetStart()
        self.Move(d)

    def Move(self, *a):
        d = VECTOR2I(*a)
        for name in ("start", "end", "mid"):
            if _kid(self._node, name) is not None:
                self._set_pt(name, self._pt(name) + d)

    def Rotate(self, centre, angle):
        for name in ("start", "end", "mid"):
            if _kid(self._node, name) is not None:
                self._set_pt(name, RotatePoint(self._pt(name), centre, angle))

    def Flip(self, centre, *_):
        cy = VECTOR2I(centre).y
        for name in ("start", "end", "mid"):
            if _kid(self._node, name) is not None:
                p = self._pt(name)
                self._set_pt(name, VECTOR2I(p.x, 2 * cy - p.y))
        self.SetLayer(FlipLayer(self.GetLayer()))

    def GetWidth(self):
        k = _kid(self._node, "width")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    def SetWidth(self, w):
        _set_kid(self._node, "width", ToMM(w))
        self._touch()

    def GetLength(self):
        return self.GetStart().Distance(self.GetEnd())

    def GetEndPoint(self, which):
        return self.GetStart() if which == 0 else self.GetEnd()

    def IsPointOnEnds(self, point, min_dist=0):
        p = VECTOR2I(point)
        return (1 if self.GetStart().Distance(p) <= min_dist else 0) | (2 if self.GetEnd().Distance(p) <= min_dist else 0)

    def IsNull(self):
        return self.GetStart() == self.GetEnd()

    def GetBoundingBox(self, *_):
        s, e, w = self.GetStart(), self.GetEnd(), self.GetWidth() // 2
        return BOX2I._of(min(s.x, e.x) - w, min(s.y, e.y) - w, max(s.x, e.x) + w, max(s.y, e.y) + w)

    def GetCenter(self):
        s, e = self.GetStart(), self.GetEnd()
        return VECTOR2I((s.x + e.x) / 2, (s.y + e.y) / 2)

    def GetLocalSolderMaskMargin(self):
        """The track's own solder mask expansion, or None when it uses the board's."""
        k = _kid(self._node, "solder_mask_margin")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else None

    def SetLocalSolderMaskMargin(self, margin=None):
        self._node[:] = [c for c in self._node if not (isinstance(c, list) and c and c[0] == "solder_mask_margin")]
        if margin is not None:
            self._node.append([Sym("solder_mask_margin"), _n(ToMM(margin))])
        self._touch()

    def HasSolderMask(self):
        return False

    def SetHasSolderMask(self, has=True):
        """A track with its own solder mask opening is not something the web editor draws: leaving it off is taken,
        turning it on says so."""
        if has:
            _unsupported("A solder mask opening on a track")




class PCB_ARC(PCB_TRACK):
    _TYPE, _CLASS, _TOKEN = PCB_ARC_T, "PCB_ARC", "arc"

    def _init_new(self):
        n = self._node
        n.extend([[Sym("start"), _n(0), _n(0)], [Sym("mid"), _n(0), _n(0)], [Sym("end"), _n(0), _n(0)], [Sym("width"), _n(0.25)], [Sym("layer"), "F.Cu"]])
        BOARD_ITEM._init_new(self)

    def GetMid(self):
        return self._pt("mid")

    def SetMid(self, *a):
        self._set_pt("mid", *a)

    def _circle(self):
        return _circle3(self.GetStart(), self.GetMid(), self.GetEnd())

    def GetCenter(self):
        c = self._circle()
        return VECTOR2I(c[0], c[1]) if c else self.GetMid()

    def GetRadius(self):
        c = self._circle()
        return c[2] if c else 0.0

    def GetAngle(self):
        c = self._circle()
        if not c:
            return EDA_ANGLE(0)
        s, m, e = self.GetStart(), self.GetMid(), self.GetEnd()
        a0 = _math.atan2(s.y - c[1], s.x - c[0])
        a1 = _math.atan2(m.y - c[1], m.x - c[0])
        a2 = _math.atan2(e.y - c[1], e.x - c[0])
        d1 = (a1 - a0) % (2 * _math.pi)
        d2 = (a2 - a0) % (2 * _math.pi)
        sweep = d2 if d1 <= d2 else d2 - 2 * _math.pi
        return EDA_ANGLE(_math.degrees(sweep))

    def GetLength(self):
        return abs(self.GetAngle().AsRadians()) * self.GetRadius()

    def IsCCW(self):
        # PCB_ARC::IsCCW: (end - start) x (mid - start) < 0, which is a positive GetAngle
        s, m, e = self.GetStart(), self.GetMid(), self.GetEnd()
        return (e.x - s.x) * (m.y - s.y) - (e.y - s.y) * (m.x - s.x) < 0

    def _end_angle(self, p):
        c = self.GetCenter()
        return EDA_ANGLE(_math.degrees(_math.atan2(p.y - c.y, p.x - c.x)) % 360.0)

    def GetArcAngleStart(self):
        return self._end_angle(self.GetStart())

    def GetArcAngleEnd(self):
        return self._end_angle(self.GetEnd())


def _circle3(a, b, c):
    ax, ay, bx, by, cx, cy = a.x, a.y, b.x, b.y, c.x, c.y
    d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-9:
        return None
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return ux, uy, _math.hypot(ax - ux, ay - uy)


class PCB_VIA(PCB_TRACK):
    _TYPE, _CLASS, _TOKEN = PCB_VIA_T, "PCB_VIA", "via"

    def _init_new(self):
        n = self._node
        n.extend([[Sym("at"), _n(0), _n(0)], [Sym("size"), _n(0.6)], [Sym("drill"), _n(0.3)], [Sym("layers"), "F.Cu", "B.Cu"]])
        BOARD_ITEM._init_new(self)

    def GetPosition(self):
        return self._pt("at")

    def SetPosition(self, *a):
        self._set_pt("at", *a)

    GetStart = GetPosition
    GetEnd = GetPosition
    SetStart = SetPosition
    SetEnd = SetPosition

    def Move(self, *a):
        self.SetPosition(self.GetPosition() + VECTOR2I(*a))

    def Rotate(self, centre, angle):
        self.SetPosition(RotatePoint(self.GetPosition(), centre, angle))

    def Flip(self, centre, *_):
        p = self.GetPosition()
        self.SetPosition(VECTOR2I(p.x, 2 * VECTOR2I(centre).y - p.y))

    def GetWidth(self, *_):
        k = _kid(self._node, "size")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    def SetWidth(self, *a):
        _set_kid(self._node, "size", ToMM(a[-1]))
        self._touch()

    def GetFrontWidth(self):
        return self.GetWidth()

    def GetDrill(self):
        k = _kid(self._node, "drill")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    GetDrillValue = GetDrill

    def SetDrill(self, d):
        _set_kid(self._node, "drill", ToMM(d))
        self._touch()

    def SetDrillDefault(self):
        pass

    def GetViaType(self):
        n = self._node
        if any(isinstance(c, Sym) and c == "micro" for c in n[1:]):
            return VIATYPE_MICROVIA
        if any(isinstance(c, Sym) and c in ("blind", "buried", "blind_buried") for c in n[1:]):
            return VIATYPE_BLIND_BURIED
        return VIATYPE_THROUGH

    def SetViaType(self, t):
        n = self._node
        n[:] = [c for c in n if not (isinstance(c, Sym) and c in ("micro", "blind", "buried", "blind_buried") and c is not n[0])]
        if t == VIATYPE_MICROVIA:
            n.insert(1, Sym("micro"))
        elif t in (VIATYPE_BLIND_BURIED, VIATYPE_BLIND, VIATYPE_BURIED):
            n.insert(1, Sym("blind"))
        self._touch()

    def _layers(self):
        k = _kid(self._node, "layers")
        return [_layer_id(x) for x in k[1:]] if k is not None else [F_Cu, B_Cu]

    def TopLayer(self):
        return self._layers()[0]

    def BottomLayer(self):
        return self._layers()[-1]

    def GetLayer(self):
        return self.TopLayer()

    def SetLayer(self, layer):
        ls = self._layers()
        self.SetLayerPair(layer, ls[-1])

    def SetLayerPair(self, top, bottom):
        _set_kid(self._node, "layers", _layer_name(top), _layer_name(bottom))
        self._touch()

    def SetTopLayer(self, layer):
        self.SetLayerPair(layer, self.BottomLayer())

    def SetBottomLayer(self, layer):
        self.SetLayerPair(self.TopLayer(), layer)

    def LayerPair(self):
        ls = self._layers()
        return ls[0], ls[-1]

    def GetLayerSet(self):
        top, bottom = self.LayerPair()
        cu = self._board._copper_layers() if self._board is not None else _CU_ORDER
        if top in cu and bottom in cu:
            return LSET(cu[cu.index(top):cu.index(bottom) + 1])
        return LSET(top, bottom)

    def IsOnLayer(self, layer, *_):
        return int(layer) in self.GetLayerSet()._s

    def GetLength(self):
        return 0.0

    def GetIsFree(self):
        return _flag(self._node, "free")

    def SetIsFree(self, on=True):
        _set_flag(self._node, "free", bool(on))
        self._touch()

    def GetBoundingBox(self, *_):
        p, r = self.GetPosition(), self.GetWidth() // 2
        return BOX2I._of(p.x - r, p.y - r, p.x + r, p.y + r)

    def GetCenter(self):
        return self.GetPosition()

    def GetRemoveUnconnected(self):
        return _flag(self._node, "remove_unused_layers")

    def SetRemoveUnconnected(self, on):
        _set_flag(self._node, "remove_unused_layers", bool(on))
        self._touch()

    def GetKeepStartEnd(self):
        return _flag(self._node, "keep_end_layers")

    def SetKeepStartEnd(self, on):
        _set_flag(self._node, "keep_end_layers", bool(on))
        self._touch()

    def SanitizeLayers(self):
        pass




class EDA_TEXT:
    """The text half of PCB_TEXT, PCB_FIELD and PCB_TEXTBOX."""

    def _effects(self, create=False):
        e = _kid(self._node, "effects")
        if e is None and create:
            e = [Sym("effects"), [Sym("font"), [Sym("size"), _n(1), _n(1)], [Sym("thickness"), _n(0.15)]]]
            self._node.append(e)
        return e

    def _font(self, create=False):
        e = self._effects(create)
        if e is None:
            return None
        f = _kid(e, "font")
        if f is None and create:
            f = [Sym("font"), [Sym("size"), _n(1), _n(1)], [Sym("thickness"), _n(0.15)]]
            e.append(f)
        return f

    def _text_index(self):
        return 2 if self._node[0] in ("fp_text", "property") else 1

    def GetText(self):
        i = self._text_index()
        return str(self._node[i]) if len(self._node) > i and not isinstance(self._node[i], list) else ""

    def SetText(self, text):
        i = self._text_index()
        while len(self._node) <= i:
            self._node.append("")
        self._node[i] = str(text)
        self._touch()

    def GetShownText(self, *_):
        t = self.GetText()
        p = getattr(self, "_parent", None)
        if p is not None and "${" in t:
            t = t.replace("${REFERENCE}", p.GetReference()).replace("${VALUE}", p.GetValue())
        return t

    def HasTextVars(self):
        return "${" in self.GetText()

    def GetTextSize(self):
        f = self._font()
        s = _kid(f, "size") if f is not None else None
        if s is None or len(s) < 3:
            return VECTOR2I(FromMM(1), FromMM(1))
        return VECTOR2I(FromMM(_f(s[2])), FromMM(_f(s[1])))      # the file writes height first

    def SetTextSize(self, *a):
        v = VECTOR2I(*a)
        _set_kid(self._font(True), "size", ToMM(v.y), ToMM(v.x))
        self._touch()

    def GetTextWidth(self):
        return self.GetTextSize().x

    def GetTextHeight(self):
        return self.GetTextSize().y

    def SetTextWidth(self, w):
        self.SetTextSize(VECTOR2I(w, self.GetTextSize().y))

    def SetTextHeight(self, h):
        self.SetTextSize(VECTOR2I(self.GetTextSize().x, h))

    def GetTextThickness(self):
        f = self._font()
        t = _kid(f, "thickness") if f is not None else None
        return FromMM(_f(t[1])) if t is not None and len(t) > 1 else FromMM(0.15)

    GetEffectiveTextPenWidth = lambda self, *_: self.GetTextThickness()

    def SetTextThickness(self, t):
        _set_kid(self._font(True), "thickness", ToMM(t))
        self._touch()

    def _at(self):
        return _kid(self._node, "at")

    def GetTextPos(self):
        return self._pt("at")

    def SetTextPos(self, *a):
        self._set_pt("at", *a)

    def SetTextX(self, x):
        self.SetTextPos(VECTOR2I(x, self.GetTextPos().y))

    def SetTextY(self, y):
        self.SetTextPos(VECTOR2I(self.GetTextPos().x, y))

    def GetTextAngle(self):
        a = self._at()
        return EDA_ANGLE(_f(a[3]) if a is not None and len(a) > 3 and not isinstance(a[3], list) and str(a[3]) != "unlocked" else 0.0)

    def GetTextAngleDegrees(self):
        return self.GetTextAngle().AsDegrees()

    def GetDrawRotation(self):
        """KiCad's: the angle the text is drawn at; footprint text kept upright stays within -90..90."""
        d = self.GetTextAngle().AsDegrees()
        fp = getattr(self, "GetParentFootprint", lambda: None)()
        if fp is not None and getattr(self, "IsKeepUpright", lambda: False)():
            while d > 90:
                d -= 180
            while d <= -90:
                d += 180
        else:
            d %= 360
        return EDA_ANGLE(d)

    def SetTextAngle(self, angle):
        a = self._at()
        if a is None:
            a = _set_kid(self._node, "at", 0, 0)
        tail = [c for c in a[3:] if str(c) == "unlocked"]
        d = _deg(angle)
        a[:] = a[:3] + ([_n(d)] if d or tail else []) + tail
        self._touch()

    def SetTextAngleDegrees(self, d):
        self.SetTextAngle(EDA_ANGLE(d))

    def IsVisible(self):
        e = self._effects()
        if _kid(self._node, "hide") is not None:
            return not _flag(self._node, "hide")
        if any(isinstance(c, Sym) and c == "hide" for c in self._node[1:]):
            return False
        if e is not None and (any(isinstance(c, Sym) and c == "hide" for c in e[1:]) or _flag(e, "hide")):
            return False
        return True

    def SetVisible(self, on):
        n = self._node
        n[:] = [c for c in n if not (isinstance(c, Sym) and c == "hide" and c is not n[0])]
        e = self._effects()
        if e is not None:
            e[:] = [c for c in e if not ((isinstance(c, Sym) and c == "hide") or (isinstance(c, list) and c and c[0] == "hide"))]
        if on:
            _drop_kid(n, "hide")
        else:
            _set_kid(n, "hide", Sym("yes"))
        self._touch()

    def _justify(self):
        e = self._effects()
        j = _kid(e, "justify") if e is not None else None
        return [str(c) for c in j[1:]] if j is not None else []

    def _set_justify(self, words):
        e = self._effects(True)
        _drop_kid(e, "justify")
        if words:
            e.append([Sym("justify")] + [Sym(w) for w in words])
        self._touch()

    def IsMirrored(self):
        return "mirror" in self._justify()

    def SetMirrored(self, on):
        w = [x for x in self._justify() if x != "mirror"]
        self._set_justify(w + (["mirror"] if on else []))

    def GetHorizJustify(self):
        for w in self._justify():
            if w in _H_ALIGN:
                return _H_ALIGN[w]
        return GR_TEXT_H_ALIGN_CENTER

    def SetHorizJustify(self, j):
        w = [x for x in self._justify() if x not in _H_ALIGN]
        self._set_justify(([k for k, v in _H_ALIGN.items() if v == j][:1]) + w)

    def GetVertJustify(self):
        for w in self._justify():
            if w in _V_ALIGN:
                return _V_ALIGN[w]
        return GR_TEXT_V_ALIGN_CENTER

    def SetVertJustify(self, j):
        w = [x for x in self._justify() if x not in _V_ALIGN]
        self._set_justify(w + ([k for k, v in _V_ALIGN.items() if v == j][:1]))

    def _font_flag(self, name):
        f = self._font()
        return f is not None and _flag(f, name)

    def _set_font_flag(self, name, on):
        f = self._font(True)
        f[:] = [c for c in f if not ((isinstance(c, Sym) and c == name and c is not f[0]) or (isinstance(c, list) and c and c[0] == name))]
        if on:
            f.append([Sym(name), Sym("yes")])
        self._touch()

    def IsItalic(self):
        return self._font_flag("italic")

    def SetItalic(self, on):
        self._set_font_flag("italic", on)

    def IsBold(self):
        return self._font_flag("bold")

    def SetBold(self, on):
        self._set_font_flag("bold", on)

    SetBoldFlag = SetBold

    def IsKeepUpright(self):
        a = self._at()
        return not (a is not None and any(str(c) == "unlocked" for c in a[3:])) and not _flag(self._node, "unlocked")

    def SetKeepUpright(self, on):
        a = self._at()
        if a is not None:
            a[:] = [c for c in a if str(c) != "unlocked"]
        _drop_kid(self._node, "unlocked")
        if not on:
            _set_kid(self._node, "unlocked", Sym("yes"))
        self._touch()

    def IsMultilineAllowed(self):
        return True

    def SetMultilineAllowed(self, on):
        pass

    def GetFont(self):
        return None

    def SetFont(self, font):
        pass

    def GetAttributes(self):
        return TEXT_ATTRIBUTES()

    def SetAttributes(self, a):
        pass

    def GetTextBox(self, *_):
        s = self.GetTextSize()
        lines = self.GetShownText().split("\n") or [""]
        w = int(max(len(l) for l in lines) * s.x * 0.9) if lines else 0
        h = int(len(lines) * s.y * 1.6)
        p = self.GetTextPos()
        hj, vj = self.GetHorizJustify(), self.GetVertJustify()
        x = p.x - (w // 2 if hj == GR_TEXT_H_ALIGN_CENTER else (w if hj == GR_TEXT_H_ALIGN_RIGHT else 0))
        y = p.y - (h // 2 if vj == GR_TEXT_V_ALIGN_CENTER else (h if vj == GR_TEXT_V_ALIGN_BOTTOM else 0))
        return BOX2I(VECTOR2I(x, y), VECTOR2I(w, h))


class PCB_TEXT(BOARD_ITEM, EDA_TEXT):
    _TYPE, _CLASS, _TOKEN = PCB_TEXT_T, "PCB_TEXT", "gr_text"

    def __init__(self, parent=None, *a):
        if isinstance(parent, FOOTPRINT):
            self._TOKEN = "fp_text"
        BOARD_ITEM.__init__(self, parent, *a)

    def _init_new(self):
        n = self._node
        if n[0] == "fp_text":
            n.append(Sym("user"))
        n.extend(["", [Sym("at"), _n(0), _n(0)], [Sym("layer"), "F.SilkS"]])
        BOARD_ITEM._init_new(self)
        self._effects(True)

    def GetPosition(self):
        return self.GetTextPos()

    def SetPosition(self, *a):
        self.SetTextPos(*a)

    def GetBoundingBox(self, *_):
        return self.GetTextBox()

    def Rotate(self, centre, angle):
        self.SetTextPos(RotatePoint(self.GetTextPos(), centre, angle))
        self.SetTextAngle(self.GetTextAngle() + EDA_ANGLE(_deg(angle)))

    def Flip(self, centre, *_):
        p = self.GetTextPos()
        self.SetTextPos(VECTOR2I(p.x, 2 * VECTOR2I(centre).y - p.y))
        self.SetLayer(FlipLayer(self.GetLayer()))
        self.SetMirrored(not self.IsMirrored())

    def GetLayer(self):
        k = _kid(self._node, "layer")
        return _layer_id(k[1]) if k is not None and len(k) > 1 else UNDEFINED_LAYER

    def IsKnockout(self):
        k = _kid(self._node, "layer")
        return k is not None and any(str(c) == "knockout" for c in k[2:])

    def GetShownText(self, *_):
        return EDA_TEXT.GetShownText(self)

    def TextHitTest(self, *a):
        return self.HitTest(*a)




class PCB_TEXTBOX(PCB_TEXT):
    _TYPE, _CLASS, _TOKEN = PCB_TEXTBOX_T, "PCB_TEXTBOX", "gr_text_box"

    def _text_index(self):
        return 1


class PCB_FIELD(PCB_TEXT):
    _TYPE, _CLASS, _TOKEN = PCB_FIELD_T, "PCB_FIELD", "property"

    def __init__(self, parent=None, field_id=0, name="", *a):
        self._field_name = str(name) if isinstance(name, str) else ""
        BOARD_ITEM.__init__(self, parent)

    def _init_new(self):
        n = self._node
        n.extend([getattr(self, "_field_name", "") or "Field", "", [Sym("at"), _n(0), _n(0)], [Sym("layer"), "F.Fab"], [Sym("hide"), Sym("yes")]])
        BOARD_ITEM._init_new(self)
        self._effects(True)

    def _text_index(self):
        return 2

    def GetName(self, *_):
        return str(self._node[1]) if len(self._node) > 1 else ""

    def SetName(self, name):
        self._node[1] = str(name)
        self._touch()

    def GetCanonicalName(self):
        return self.GetName()

    def CloneField(self):
        return self.Duplicate()

    def IsReference(self):
        return self.GetName() == "Reference"

    def IsValue(self):
        return self.GetName() == "Value"

    def IsDatasheet(self):
        return self.GetName() == "Datasheet"

    def IsMandatory(self):
        return self.GetName() in ("Reference", "Value", "Footprint", "Datasheet", "Description")

    IsMandatoryField = IsMandatory

    def GetId(self):
        return {"Reference": 0, "Value": 1, "Footprint": 2, "Datasheet": 3, "Description": 4}.get(self.GetName(), 5)


class _LegacyFieldText(PCB_TEXT):
    """KiCad 7's reference / value: (fp_text reference "R1" ...)."""

    def GetName(self, *_):
        return "Reference" if str(self._node[1]) == "reference" else "Value"

    IsReference = lambda self: str(self._node[1]) == "reference"
    IsValue = lambda self: str(self._node[1]) == "value"


class SHAPE_LINE_CHAIN:
    def __init__(self, points=None, closed=False):
        self._pts = [VECTOR2I(p) for p in (points or [])]
        self._closed = closed

    def Append(self, *a):
        if len(a) == 1 and isinstance(a[0], SHAPE_LINE_CHAIN):
            self._pts.extend(VECTOR2I(p) for p in a[0]._pts)
        else:
            self._pts.append(VECTOR2I(*a[:2]) if len(a) >= 2 and not isinstance(a[0], (VECTOR2I, tuple, list)) else VECTOR2I(a[0]))

    def PointCount(self):
        return len(self._pts)

    GetPointCount = PointCount

    def SegmentCount(self):
        n = len(self._pts)
        return n if self._closed else max(0, n - 1)

    def CPoint(self, i):
        return self._pts[i % len(self._pts)]

    GetPoint = CPoint
    CLastPoint = lambda self: self._pts[-1]

    def CPoints(self):
        return list(self._pts)

    def SetPoint(self, i, p):
        self._pts[i] = VECTOR2I(p)

    def SetClosed(self, closed):
        self._closed = bool(closed)

    def IsClosed(self):
        return self._closed

    def Clear(self):
        self._pts = []

    def Remove(self, i, j=None):
        del self._pts[i:(j if j is not None else i) + 1]

    def Reverse(self):
        return SHAPE_LINE_CHAIN(list(reversed(self._pts)), self._closed)

    def Length(self):
        pts = self._pts + (self._pts[:1] if self._closed else [])
        return sum(pts[i].Distance(pts[i + 1]) for i in range(len(pts) - 1))

    def Area(self, absolute=True):
        a = 0.0
        n = len(self._pts)
        for i in range(n):
            p, q = self._pts[i], self._pts[(i + 1) % n]
            a += p.x * q.y - q.x * p.y
        a /= 2.0
        return abs(a) if absolute else a

    def BBox(self, *_):
        b = BOX2I()
        for p in self._pts:
            b.Merge(p)
        return b

    def PointInside(self, point, accuracy=0, *_):
        p = VECTOR2I(point)
        inside = False
        n = len(self._pts)
        for i in range(n):
            a, b = self._pts[i], self._pts[(i + 1) % n]
            if (a.y > p.y) != (b.y > p.y) and p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x:
                inside = not inside
        return inside

    def SquaredDistance(self, point, outline_only=False):
        """As KiCad's: nothing for a point inside a closed chain (unless only the outline counts), else the square of
        the distance to the nearest segment."""
        p = VECTOR2I(point)
        if self._closed and not outline_only and self.PointInside(p):
            return 0
        best = None
        n = len(self._pts)
        for i in range(n if self._closed else n - 1):
            a, b = self._pts[i], self._pts[(i + 1) % n]
            vx, vy = b.x - a.x, b.y - a.y
            ll = vx * vx + vy * vy
            t = 0.0 if ll == 0 else max(0.0, min(1.0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / ll))
            dx, dy = p.x - a.x - t * vx, p.y - a.y - t * vy
            d = dx * dx + dy * dy
            best = d if best is None or d < best else best
        if best is None:
            best = float((p.x - self._pts[0].x) ** 2 + (p.y - self._pts[0].y) ** 2) if self._pts else 0.0
        return int(round(best))

    def Distance(self, point, outline_only=False):
        return int(round(_math.sqrt(self.SquaredDistance(point, outline_only))))

    def Move(self, d):
        self._pts = [p + d for p in self._pts]

    def Rotate(self, angle, centre=(0, 0)):
        self._pts = [RotatePoint(VECTOR2I(p), centre, angle) for p in self._pts]

    def Simplify(self, *_):
        return self

    def ArcCount(self):
        return 0

    def __len__(self):
        return len(self._pts)

    def __iter__(self):
        return iter(self._pts)


class SHAPE_POLY_SET:
    def __init__(self, other=None):
        self._outlines = []          # each: [outline chain, hole chain, ...]
        if isinstance(other, SHAPE_POLY_SET):
            self._outlines = [[SHAPE_LINE_CHAIN(c._pts, True) for c in o] for o in other._outlines]
        elif isinstance(other, SHAPE_LINE_CHAIN):
            self._outlines = [[SHAPE_LINE_CHAIN(other._pts, True)]]

    def NewOutline(self):
        self._outlines.append([SHAPE_LINE_CHAIN(closed=True)])
        return len(self._outlines) - 1

    def NewHole(self, outline=-1):
        self._outlines[outline].append(SHAPE_LINE_CHAIN(closed=True))
        return len(self._outlines[outline]) - 2

    def AddOutline(self, chain):
        self._outlines.append([SHAPE_LINE_CHAIN(chain._pts, True)])
        return len(self._outlines) - 1

    def AddHole(self, chain, outline=-1):
        self._outlines[outline].append(SHAPE_LINE_CHAIN(chain._pts, True))

    def Append(self, *a):
        if len(a) == 1 and isinstance(a[0], SHAPE_POLY_SET):
            self._outlines.extend([[SHAPE_LINE_CHAIN(c._pts, True) for c in o] for o in a[0]._outlines])
            return
        if not self._outlines:
            self.NewOutline()
        nums = [x for x in a if isinstance(x, (int, float))]
        if isinstance(a[0], (VECTOR2I, tuple, list)):
            p, rest = VECTOR2I(a[0]), list(a[1:])
        else:
            p, rest = VECTOR2I(nums[0], nums[1]), list(nums[2:])
        outline = int(rest[0]) if len(rest) > 0 else -1
        hole = int(rest[1]) if len(rest) > 1 else -1
        self._outlines[outline][hole + 1].Append(p)

    def OutlineCount(self):
        return len(self._outlines)

    def HoleCount(self, outline):
        return len(self._outlines[outline]) - 1

    def Outline(self, i):
        return self._outlines[i][0]

    COutline = Outline

    def Hole(self, outline, hole):
        return self._outlines[outline][hole + 1]

    CHole = Hole

    def Polygon(self, i):
        return self._outlines[i]

    CPolygon = Polygon

    def UnitSet(self, i):
        s = SHAPE_POLY_SET()
        s._outlines = [self._outlines[i]]
        return s

    def VertexCount(self, outline=-1, hole=-1):
        if outline < 0:
            return self.TotalVertices()
        return self._outlines[outline][hole + 1].PointCount()

    def FullPointCount(self):
        return self.TotalVertices()

    def TotalVertices(self):
        return sum(c.PointCount() for o in self._outlines for c in o)

    def CVertex(self, index, outline=None, hole=-1):
        if outline is None:
            for o in self._outlines:
                for c in o:
                    if index < c.PointCount():
                        return c.CPoint(index)
                    index -= c.PointCount()
            raise IndexError(index)
        return self._outlines[outline][hole + 1].CPoint(index)

    def RemoveAllContours(self):
        self._outlines = []

    def RemoveContour(self, i, polygon=-1):
        del self._outlines[polygon][i]

    def DeletePolygon(self, i):
        del self._outlines[i]

    def IsEmpty(self):
        return not self._outlines

    def BBox(self, *_):
        b = BOX2I()
        for o in self._outlines:
            b.Merge(o[0].BBox())
        return b

    def Area(self):
        return sum(o[0].Area() - sum(h.Area() for h in o[1:]) for o in self._outlines)

    def Contains(self, point, *_):
        for o in self._outlines:
            if o[0].PointInside(point) and not any(h.PointInside(point) for h in o[1:]):
                return True
        return False

    def Collide(self, *a):
        """With a point: is it inside.  With a shape (and a clearance): do they touch, or lie closer than that."""
        if not a:
            return False
        other = a[0]
        clearance = a[1] if len(a) > 1 and isinstance(a[1], (int, float)) and not isinstance(a[1], bool) else 0
        if isinstance(other, (SHAPE, SHAPE_POLY_SET, SHAPE_LINE_CHAIN, BOARD_ITEM, BOX2I)) or clearance:
            return _collide(self._geom(), _geom_of(other), clearance)
        return self.Contains(other)

    def BuildBBoxCaches(self):
        """KiCad keeps boxes to make Contains quick; nothing is kept here."""

    def Move(self, d):
        for o in self._outlines:
            for c in o:
                c.Move(d)

    def Rotate(self, angle, centre=(0, 0)):
        for o in self._outlines:
            for c in o:
                c.Rotate(angle, centre)

    def Mirror(self, *_):
        pass

    def Iterate(self, *_):
        return [p for o in self._outlines for p in o[0]._pts]

    def IterateWithHoles(self, *_):
        return [p for o in self._outlines for c in o for p in c._pts]

    # -- set operations: done with shapely (GEOS), which the runtime loads for a plugin that uses them
    @staticmethod
    def _shapely():
        try:
            import shapely
            import shapely.geometry          # noqa: F401
            return shapely
        except ImportError:
            _unsupported("Polygon set operations (the shapely package could not be loaded)")

    def _geom(self):
        sh = self._shapely()
        polys = []
        for o in self._outlines:
            pts = [(p.x, p.y) for p in o[0]._pts]
            if len(pts) < 3:
                continue
            g = sh.geometry.Polygon(pts, [[(p.x, p.y) for p in h._pts] for h in o[1:] if len(h._pts) >= 3])
            if not g.is_valid:
                g = g.buffer(0)
            if not g.is_empty:
                polys.append(g)
        return sh.unary_union(polys) if polys else sh.geometry.Polygon()

    def _take_geom(self, g):
        self._outlines = []
        parts = [g] if g.geom_type == "Polygon" else [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]
        for part in parts:
            if part.is_empty:
                continue
            chain = lambda ring: SHAPE_LINE_CHAIN([VECTOR2I(int(round(x)), int(round(y))) for x, y in list(ring.coords)[:-1]], True)
            self._outlines.append([chain(part.exterior)] + [chain(r) for r in part.interiors])

    def Inflate(self, amount, cornerStrategy=None, maxError=None, *_):
        """Grow (or, with a negative amount, shrink) the polygons, with KiCad's corner strategies."""
        amount = float(amount)
        if not self._outlines or amount == 0:
            return
        g = self._geom()
        err = float(maxError) if isinstance(maxError, (int, float)) and maxError and maxError > 0 else 5000.0
        r = abs(amount)
        segs = 4
        if r > err:
            segs = max(2, min(32, int(_math.ceil((_math.pi / 2) / (2 * _math.acos(1 - err / r))))))
        join = "round"
        if cornerStrategy in (CORNER_STRATEGY_ALLOW_ACUTE_CORNERS, CORNER_STRATEGY_CHAMFER_ACUTE_CORNERS, CORNER_STRATEGY_ROUND_ACUTE_CORNERS):
            join = "mitre"
        elif cornerStrategy == CORNER_STRATEGY_CHAMFER_ALL_CORNERS:
            join = "bevel"
        self._take_geom(g.buffer(amount, quad_segs=segs, join_style=join, mitre_limit=5.0))

    def Deflate(self, amount, *a):
        self.Inflate(-float(amount), *a)

    InflateWithLinkedHoles = Inflate

    def _boolean(self, op, a):
        polys = [x for x in a if isinstance(x, SHAPE_POLY_SET)]
        if not polys:
            return
        left, right = (polys[0], polys[1]) if len(polys) > 1 else (self, polys[0])
        self._take_geom(getattr(left._geom(), op)(right._geom()))

    def BooleanAdd(self, *a):
        self._boolean("union", a)

    def BooleanSubtract(self, *a):
        self._boolean("difference", a)

    def BooleanIntersection(self, *a):
        self._boolean("intersection", a)

    def BooleanXor(self, *a):
        self._boolean("symmetric_difference", a)

    def Simplify(self, *_):
        # overlapping outlines become one; without the clipper they are left as they are
        try:
            import shapely          # noqa: F401
        except ImportError:
            return
        if len(self._outlines) > 1 or any(len(o) > 1 for o in self._outlines):
            self._take_geom(self._geom())

    def Fracture(self, *_):
        pass

    def Unfracture(self, *_):
        pass

    def CacheTriangulation(self, *_):
        pass

    def ClearArcs(self):
        pass

    def HasHoles(self):
        return any(len(o) > 1 for o in self._outlines)

    def _to_nodes(self, to_local):
        out = []
        for o in self._outlines:
            pts = [Sym("pts")]
            for p in o[0]._pts:
                x, y = to_local(ToMM(p.x), ToMM(p.y))
                pts.append([Sym("xy"), _n(x), _n(y)])
            out.append(pts)
        return out


class _ZoneOutline(SHAPE_POLY_SET):
    """zone.Outline(): the zone's own outline, as on the desktop.  What is changed through it is changed in the zone."""

    def _sync(self):
        z = self._zone
        z.SetOutline(self)
        z.__dict__["_live"] = (z.__dict__.get("_rev", 0), self, z._node)

    def AddOutline(self, chain):
        i = SHAPE_POLY_SET.AddOutline(self, chain)
        z = self._zone                    # one more polygon: appended, so that a thousand of them stay cheap
        one = SHAPE_POLY_SET()
        one._outlines = [self._outlines[i]]
        for pts in one._to_nodes(z._to_local):
            z._node.append([Sym("polygon"), pts])
        z._touch()
        z.__dict__["_live"] = (z.__dict__.get("_rev", 0), self, z._node)         # still the zone's outline as it stands
        return i


def _zone_outline_method(name):
    base = getattr(SHAPE_POLY_SET, name)

    def method(self, *a, **k):
        r = base(self, *a, **k)
        self._sync()
        return r
    method.__name__ = name
    return method


for _name in ("NewOutline", "NewHole", "AddHole", "Append", "RemoveAllContours", "RemoveContour", "DeletePolygon", "Move", "Rotate", "Mirror",
              "Inflate", "BooleanAdd", "BooleanSubtract", "BooleanIntersection", "Simplify", "Fracture", "Unfracture"):
    setattr(_ZoneOutline, _name, _zone_outline_method(_name))


def _pts_of(node, to_board):
    pts = _kid(node, "pts")
    out = []
    if pts is not None:
        for c in pts[1:]:
            if isinstance(c, list) and c and c[0] == "xy" and len(c) >= 3:
                x, y = to_board(_f(c[1]), _f(c[2]))
                out.append(VECTOR2I(FromMM(x), FromMM(y)))
            elif isinstance(c, list) and c and c[0] == "arc":
                for name in ("start", "mid", "end"):
                    k = _kid(c, name)
                    if k is not None and len(k) >= 3:
                        x, y = to_board(_f(k[1]), _f(k[2]))
                        out.append(VECTOR2I(FromMM(x), FromMM(y)))
    return out


_SHAPE_OF = {"line": SHAPE_T_SEGMENT, "rect": SHAPE_T_RECTANGLE, "arc": SHAPE_T_ARC, "circle": SHAPE_T_CIRCLE, "poly": SHAPE_T_POLY,
             "curve": SHAPE_T_BEZIER, "bezier": SHAPE_T_BEZIER}
_SHAPE_TOKEN = {v: k for k, v in _SHAPE_OF.items() if k != "bezier"}


class PCB_SHAPE(BOARD_CONNECTED_ITEM):
    _TYPE, _CLASS, _TOKEN = PCB_SHAPE_T, "PCB_SHAPE", "gr_line"

    def __init__(self, parent=None, shape=SHAPE_T_SEGMENT, *a):
        self._prefix = "fp_" if isinstance(parent, FOOTPRINT) else "gr_"
        self._TOKEN = self._prefix + _SHAPE_TOKEN.get(shape if isinstance(shape, int) else SHAPE_T_SEGMENT, "line")
        BOARD_ITEM.__init__(self, parent)

    def _init_new(self):
        n = self._node
        kind = str(n[0])[3:]
        if kind == "circle":
            n.extend([[Sym("center"), _n(0), _n(0)], [Sym("end"), _n(0), _n(0)]])
        elif kind == "arc":
            n.extend([[Sym("start"), _n(0), _n(0)], [Sym("mid"), _n(0), _n(0)], [Sym("end"), _n(0), _n(0)]])
        elif kind == "poly":
            n.append([Sym("pts")])
        else:
            n.extend([[Sym("start"), _n(0), _n(0)], [Sym("end"), _n(0), _n(0)]])
        n.extend([[Sym("stroke"), [Sym("width"), _n(0.1)], [Sym("type"), Sym("default")]], [Sym("layer"), "Dwgs.User"]])
        BOARD_ITEM._init_new(self)

    def _kind(self):
        return str(self._node[0])[3:]

    def GetShape(self):
        return _SHAPE_OF.get(self._kind(), SHAPE_T_SEGMENT)

    def SetShape(self, shape):
        old = self._kind()
        new = _SHAPE_TOKEN.get(shape, "line")
        if new == old:
            return
        self._node[0] = Sym(str(self._node[0])[:3] + new)
        if new == "circle" and _kid(self._node, "center") is None:
            s = _kid(self._node, "start")
            if s is not None:
                s[0] = Sym("center")
        if new == "poly" and _kid(self._node, "pts") is None:
            _drop_kid(self._node, "start")
            _drop_kid(self._node, "end")
            self._node.insert(1, [Sym("pts")])
        if new == "arc" and _kid(self._node, "mid") is None:
            self._node.insert(2, [Sym("mid"), _n(0), _n(0)])
        self._touch()

    def ShowShape(self):
        return {"line": "Line", "rect": "Rect", "arc": "Arc", "circle": "Circle", "poly": "Polygon", "curve": "Bezier"}.get(self._kind(), "Line")

    SHAPE_T_asString = ShowShape

    def GetStart(self):
        return self._pt("center" if self._kind() == "circle" else "start")

    def SetStart(self, *a):
        self._set_pt("center" if self._kind() == "circle" else "start", *a)

    def GetEnd(self):
        return self._pt("end")

    def SetEnd(self, *a):
        self._set_pt("end", *a)

    def GetStartX(self):
        return self.GetStart().x

    def GetStartY(self):
        return self.GetStart().y

    def GetEndX(self):
        return self.GetEnd().x

    def GetEndY(self):
        return self.GetEnd().y

    def SetStartX(self, x):
        self.SetStart(VECTOR2I(x, self.GetStart().y))

    def SetStartY(self, y):
        self.SetStart(VECTOR2I(self.GetStart().x, y))

    def SetEndX(self, x):
        self.SetEnd(VECTOR2I(x, self.GetEnd().y))

    def SetEndY(self, y):
        self.SetEnd(VECTOR2I(self.GetEnd().x, y))

    def GetArcMid(self):
        return self._pt("mid")

    def SetArcGeometry(self, start, mid, end):
        self._set_pt("start", start)
        self._set_pt("mid", mid)
        self._set_pt("end", end)

    def SetArcAngleAndEnd(self, angle, *_):
        c, s = self.GetCenter(), self.GetStart()
        e = RotatePoint(VECTOR2I(s), c, -_deg(angle))
        m = RotatePoint(VECTOR2I(s), c, -_deg(angle) / 2.0)
        self._set_pt("mid", m)
        self._set_pt("end", e)

    def GetArcStart(self):
        return self.GetStart()

    def GetArcEnd(self):
        return self.GetEnd()

    def GetArcAngle(self):
        c = _circle3(self.GetStart(), self.GetArcMid(), self.GetEnd())
        if not c:
            return 0.0 if _Host.kicad6 else EDA_ANGLE(0)
        s, m, e = self.GetStart(), self.GetArcMid(), self.GetEnd()
        a0, a1, a2 = (_math.atan2(p.y - c[1], p.x - c[0]) for p in (s, m, e))
        d1, d2 = (a1 - a0) % (2 * _math.pi), (a2 - a0) % (2 * _math.pi)
        deg = _math.degrees(d2 if d1 <= d2 else d2 - 2 * _math.pi)
        return deg * 10.0 if _Host.kicad6 else EDA_ANGLE(deg)       # KiCad 6 spoke in tenths of a degree

    def GetArcAngleStart(self):
        """KiCad 6 only (later versions have CalcArcAngles): the angle of the arc's start seen from its centre, in tenths
        of a degree.  A plugin that asks is written for KiCad 6 and is answered in its terms from here on."""
        _Host.kicad6 = True
        c, s = self.GetCenter(), self.GetStart()
        return (_math.degrees(_math.atan2(s.y - c.y, s.x - c.x)) % 360.0) * 10.0

    def GetCenter(self):
        k = self._kind()
        if k == "circle":
            return self._pt("center")
        if k == "arc":
            c = _circle3(self.GetStart(), self.GetArcMid(), self.GetEnd())
            return VECTOR2I(c[0], c[1]) if c else self.GetArcMid()
        if k == "poly":
            return self.GetBoundingBox().GetCenter()
        s, e = self.GetStart(), self.GetEnd()
        return VECTOR2I((s.x + e.x) / 2, (s.y + e.y) / 2)

    def SetCenter(self, *a):
        k = self._kind()
        if k == "circle":
            r = self.GetRadius()
            p = VECTOR2I(*a)
            self._set_pt("center", p)
            self._set_pt("end", VECTOR2I(p.x + r, p.y))
        else:
            self.Move(VECTOR2I(*a) - self.GetCenter())

    def GetRadius(self):
        k = self._kind()
        if k == "circle":
            return int(round(self._pt("center").Distance(self._pt("end"))))
        if k == "arc":
            c = _circle3(self.GetStart(), self.GetArcMid(), self.GetEnd())
            return int(round(c[2])) if c else 0
        return 0

    def SetRadius(self, r):
        c = self._pt("center")
        self._set_pt("end", VECTOR2I(c.x + r, c.y))

    def GetPosition(self):
        k = self._kind()
        if k == "poly":
            pts = self._poly_points()
            return pts[0] if pts else VECTOR2I(0, 0)
        return self.GetStart()

    def SetPosition(self, *a):
        self.Move(VECTOR2I(*a) - self.GetPosition())

    def _point_names(self):
        return [n for n in ("start", "mid", "end", "center") if _kid(self._node, n) is not None]

    def Move(self, *a):
        d = VECTOR2I(*a)
        for n in self._point_names():
            self._set_pt(n, self._pt(n) + d)
        if _kid(self._node, "pts") is not None:
            self.SetPolyPoints([p + d for p in self._poly_points()])

    def Rotate(self, centre, angle):
        if self._kind() == "rect" and _deg(angle) % 90:
            c = self.GetRectCorners()
            self.SetShape(SHAPE_T_POLY)
            self.SetPolyPoints([RotatePoint(VECTOR2I(p), centre, angle) for p in c])
            return
        for n in self._point_names():
            self._set_pt(n, RotatePoint(self._pt(n), centre, angle))
        if _kid(self._node, "pts") is not None:
            self.SetPolyPoints([RotatePoint(VECTOR2I(p), centre, angle) for p in self._poly_points()])

    def Flip(self, centre, *_):
        cy = VECTOR2I(centre).y
        for n in self._point_names():
            p = self._pt(n)
            self._set_pt(n, VECTOR2I(p.x, 2 * cy - p.y))
        if _kid(self._node, "pts") is not None:
            self.SetPolyPoints([VECTOR2I(p.x, 2 * cy - p.y) for p in self._poly_points()])
        self.SetLayer(FlipLayer(self.GetLayer()))

    def _stroke(self, create=False):
        s = _kid(self._node, "stroke")
        if s is None and create:
            s = [Sym("stroke"), [Sym("width"), _n(0.1)], [Sym("type"), Sym("default")]]
            self._node.append(s)
        return s

    def GetWidth(self):
        s = self._stroke()
        w = _kid(s, "width") if s is not None else _kid(self._node, "width")
        return FromMM(_f(w[1])) if w is not None and len(w) > 1 else 0

    GetEffectiveWidth = GetWidth

    def SetWidth(self, w):
        _set_kid(self._stroke(True), "width", ToMM(w))
        _drop_kid(self._node, "width")
        self._touch()

    _LINE_STYLES = ("default", "solid", "dash", "dot", "dash_dot", "dash_dot_dot")

    def GetLineStyle(self):
        s = self._stroke()
        t = _kid(s, "type") if s is not None else None
        name = str(t[1]) if t is not None and len(t) > 1 else "default"
        return self._LINE_STYLES.index(name) if name in self._LINE_STYLES else 0

    def SetLineStyle(self, style):
        style = int(style)
        _set_kid(self._stroke(True), "type", Sym(self._LINE_STYLES[style] if 0 <= style < len(self._LINE_STYLES) else "default"))
        self._touch()

    def GetStroke(self):
        return STROKE_PARAMS(self.GetWidth(), self.GetLineStyle())

    def SetStroke(self, stroke):
        self.SetWidth(stroke.GetWidth())
        self.SetLineStyle(stroke.GetLineStyle())

    def IsFilled(self):
        k = _kid(self._node, "fill")
        return k is not None and len(k) > 1 and str(k[1]) not in ("none", "no")

    IsSolidFill = IsFilled

    def SetFilled(self, on):
        _set_kid(self._node, "fill", Sym("yes" if on else "no"))
        self._touch()

    def SetFillMode(self, mode):
        self.SetFilled(bool(mode))

    def _poly_points(self):
        return _pts_of(self._node, self._to_board)

    def GetPolyShape(self):
        s = SHAPE_POLY_SET()
        pts = self._poly_points()
        if pts:
            s._outlines.append([SHAPE_LINE_CHAIN(pts, True)])
        return s

    def SetPolyShape(self, poly):
        self.SetPolyPoints(poly.Outline(0).CPoints() if poly.OutlineCount() else [])

    def SetPolyPoints(self, points):
        pts = [Sym("pts")]
        for p in points:
            p = VECTOR2I(p)
            x, y = self._to_local(ToMM(p.x), ToMM(p.y))
            pts.append([Sym("xy"), _n(x), _n(y)])
        k = _kid(self._node, "pts")
        if k is None:
            self._node.insert(1, pts)
        else:
            k[:] = pts
        self._touch()

    def GetPolyPoints(self):
        return self._poly_points()

    def GetPointCount(self):
        return len(self._poly_points())

    def GetRectCorners(self):
        s, e = self.GetStart(), self.GetEnd()
        return [VECTOR2I(s.x, s.y), VECTOR2I(e.x, s.y), VECTOR2I(e.x, e.y), VECTOR2I(s.x, e.y)]

    def GetCorners(self):
        return self.GetRectCorners() if self._kind() == "rect" else self._poly_points()

    def CalcArcAngles(self, start_angle, end_angle):
        """KiCad's: the angles of the arc's two ends seen from its centre, the end one never below the start one."""
        c = self.GetCenter()
        if self._kind() == "circle":
            a = b = 0.0
        else:
            s, e = self.GetStart(), self.GetEnd()
            if self.GetArcAngle().AsDegrees() < 0:
                s, e = e, s
            a = _math.degrees(_math.atan2(s.y - c.y, s.x - c.x))
            b = _math.degrees(_math.atan2(e.y - c.y, e.x - c.x))
        if b == a:
            b = a + 360.0
        while b < a:
            b += 360.0
        start_angle._deg, end_angle._deg = a, b

    def GetBezControl1(self):
        return self.GetBezierC1()

    def GetBezControl2(self):
        return self.GetBezierC2()

    def GetBezierC1(self):
        pts = self._poly_points()
        return pts[1] if len(pts) > 1 else VECTOR2I(0, 0)

    def GetBezierC2(self):
        pts = self._poly_points()
        return pts[2] if len(pts) > 2 else VECTOR2I(0, 0)

    def GetLength(self):
        k = self._kind()
        if k == "circle":
            return 2 * _math.pi * self.GetRadius()
        if k == "arc":
            return abs(self.GetArcAngle().AsRadians()) * self.GetRadius()
        if k == "poly":
            return SHAPE_LINE_CHAIN(self._poly_points(), True).Length()
        if k == "rect":
            s, e = self.GetStart(), self.GetEnd()
            return 2 * (abs(e.x - s.x) + abs(e.y - s.y))
        return self.GetStart().Distance(self.GetEnd())

    def GetBoundingBox(self, *_):
        k = self._kind()
        w = self.GetWidth() // 2
        if k == "circle":
            c, r = self._pt("center"), self.GetRadius()
            return BOX2I._of(c.x - r - w, c.y - r - w, c.x + r + w, c.y + r + w)
        pts = self._poly_points() if k in ("poly", "curve") else [self._pt(n) for n in self._point_names()]
        if k == "arc":
            c = _circle3(self.GetStart(), self.GetArcMid(), self.GetEnd())
            if c:
                pts = pts + [VECTOR2I(c[0] + dx * c[2], c[1] + dy * c[2]) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)) if self._arc_has(c, dx, dy)]
        b = BOX2I()
        for p in pts:
            b.Merge(p)
        return b.Inflate(w) if pts else b

    def _arc_has(self, c, dx, dy):
        s, m, e = self.GetStart(), self.GetArcMid(), self.GetEnd()
        a0, a1, a2 = (_math.atan2(p.y - c[1], p.x - c[0]) for p in (s, m, e))
        t = _math.atan2(dy, dx)
        d1, d2, dt = (a1 - a0) % (2 * _math.pi), (a2 - a0) % (2 * _math.pi), (t - a0) % (2 * _math.pi)
        return dt <= d2 if d1 <= d2 else dt >= d2

    def IsClosed(self):
        return self._kind() in ("circle", "rect", "poly")

    def GetFriendlyName(self):
        return self.ShowShape()




LINE_STYLE_DEFAULT, LINE_STYLE_SOLID, LINE_STYLE_DASH, LINE_STYLE_DOT, LINE_STYLE_DASHDOT, LINE_STYLE_DASHDOTDOT = range(6)


class STROKE_PARAMS:
    def __init__(self, width=0, style=0, *_):
        self._w, self._s = width, style

    def GetWidth(self):
        return self._w

    def SetWidth(self, w):
        self._w = w

    def GetLineStyle(self):
        return self._s

    GetPlotStyle = GetLineStyle

    def SetLineStyle(self, s):
        self._s = s

    SetPlotStyle = SetLineStyle


class PAD(BOARD_CONNECTED_ITEM):
    _TYPE, _CLASS, _TOKEN = PCB_PAD_T, "PAD", "pad"

    def _init_new(self):
        n = self._node
        n.extend(["", Sym("smd"), Sym("rect"), [Sym("at"), _n(0), _n(0)], [Sym("size"), _n(1), _n(1)], [Sym("layers"), "F.Cu", "F.Mask", "F.Paste"]])
        BOARD_ITEM._init_new(self)

    def GetNumber(self):
        return str(self._node[1]) if len(self._node) > 1 else ""

    GetName = GetNumber
    GetPadName = GetNumber

    def SetNumber(self, n):
        self._node[1] = str(n)
        self._touch()

    SetName = SetNumber
    SetPadName = SetNumber

    def GetAttribute(self):
        return _PAD_ATTR.get(str(self._node[2]) if len(self._node) > 2 else "", PAD_ATTRIB_SMD)

    def SetAttribute(self, a):
        self._node[2] = Sym({v: k for k, v in _PAD_ATTR.items()}.get(a, "smd"))
        self._touch()

    def GetShape(self, *_):
        return _PAD_SHAPE.get(str(self._node[3]) if len(self._node) > 3 else "", PAD_SHAPE_RECTANGLE)

    def SetShape(self, *a):
        self._node[3] = Sym({v: k for k, v in _PAD_SHAPE.items()}.get(a[-1], "rect"))
        self._touch()

    def ShowPadShape(self, *_):
        return str(self._node[3]) if len(self._node) > 3 else ""

    def ShowPadAttr(self):
        return str(self._node[2]) if len(self._node) > 2 else ""

    def GetProperty(self):
        k = _kid(self._node, "property")
        return {"pad_prop_bga": PAD_PROP_BGA, "pad_prop_fiducial_glob": PAD_PROP_FIDUCIAL_GLBL, "pad_prop_fiducial_loc": PAD_PROP_FIDUCIAL_LOCAL,
                "pad_prop_testpoint": PAD_PROP_TESTPOINT, "pad_prop_heatsink": PAD_PROP_HEATSINK, "pad_prop_castellated": PAD_PROP_CASTELLATED,
                "pad_prop_mechanical": PAD_PROP_MECHANICAL}.get(str(k[1]) if k is not None and len(k) > 1 else "", PAD_PROP_NONE)

    def SetProperty(self, prop):
        word = {PAD_PROP_BGA: "pad_prop_bga", PAD_PROP_FIDUCIAL_GLBL: "pad_prop_fiducial_glob", PAD_PROP_FIDUCIAL_LOCAL: "pad_prop_fiducial_loc",
                PAD_PROP_TESTPOINT: "pad_prop_testpoint", PAD_PROP_HEATSINK: "pad_prop_heatsink", PAD_PROP_CASTELLATED: "pad_prop_castellated",
                PAD_PROP_MECHANICAL: "pad_prop_mechanical"}.get(int(prop))
        if word is None:
            _drop_kid(self._node, "property")
        else:
            _set_kid(self._node, "property", Sym(word))
        self._touch()

    def GetPos0(self):
        k = _kid(self._node, "at")
        return VECTOR2I(FromMM(_f(k[1])), FromMM(_f(k[2]))) if k is not None and len(k) > 2 else VECTOR2I(0, 0)

    GetFPRelativePosition = GetPos0

    def SetPos0(self, *a):
        p = VECTOR2I(*a)
        k = _kid(self._node, "at")
        rest = k[3:] if k is not None else []
        _set_kid(self._node, "at", ToMM(p.x), ToMM(p.y)).extend(rest)
        self._touch()

    SetFPRelativePosition = SetPos0

    def GetOrientation(self):
        k = _kid(self._node, "at")
        stored = _f(k[3]) if k is not None and len(k) > 3 and not isinstance(k[3], list) else 0.0
        p = self._parent
        if p is not None and getattr(p, "_pending", None):
            stored += p._placement()[2] - p._stored_rot()       # the file keeps a pad's angle in board terms
        return EDA_ANGLE(stored)

    def GetOrientationDegrees(self):
        return self.GetOrientation().AsDegrees()

    def GetFPRelativeOrientation(self):
        p = self._parent
        return EDA_ANGLE(self.GetOrientation().AsDegrees() - (p._placement()[2] if p is not None else 0.0))

    def SetOrientation(self, angle):
        k = _kid(self._node, "at")
        if k is None:
            k = _set_kid(self._node, "at", 0, 0)
        p = self._parent
        d = _deg(angle)
        if p is not None and getattr(p, "_pending", None):
            d -= p._placement()[2] - p._stored_rot()
        k[:] = k[:3] + ([_n(d)] if d else [])
        self._touch()

    def SetOrientationDegrees(self, d):
        self.SetOrientation(EDA_ANGLE(d))

    def GetSize(self, *_):
        k = _kid(self._node, "size")
        return VECTOR2I(FromMM(_f(k[1])), FromMM(_f(k[2]))) if k is not None and len(k) > 2 else VECTOR2I(0, 0)

    def SetSize(self, *a):
        s = VECTOR2I(a[-1]) if isinstance(a[-1], (VECTOR2I, tuple, list)) else VECTOR2I(*a[-2:])
        _set_kid(self._node, "size", ToMM(s.x), ToMM(s.y))
        self._touch()

    def GetSizeX(self):
        return self.GetSize().x

    def GetSizeY(self):
        return self.GetSize().y

    def SetSizeX(self, v):
        self.SetSize(VECTOR2I(v, self.GetSize().y))

    def SetSizeY(self, v):
        self.SetSize(VECTOR2I(self.GetSize().x, v))

    def GetDrillSize(self):
        k = _kid(self._node, "drill")
        if k is None:
            return VECTOR2I(0, 0)
        nums = [_f(c) for c in k[1:] if not isinstance(c, list) and str(c) != "oval"]
        if not nums:
            return VECTOR2I(0, 0)
        return VECTOR2I(FromMM(nums[0]), FromMM(nums[1] if len(nums) > 1 else nums[0]))

    def SetDrillSize(self, *a):
        s = VECTOR2I(*a)
        k = _kid(self._node, "drill")
        off = _kid(k, "offset") if k is not None else None
        if s.x == s.y:
            k = _set_kid(self._node, "drill", ToMM(s.x))
        else:
            k = _set_kid(self._node, "drill", Sym("oval"), ToMM(s.x), ToMM(s.y))
        if off is not None:
            k.append(off)
        self._touch()

    def GetDrillSizeX(self):
        return self.GetDrillSize().x

    def GetDrillSizeY(self):
        return self.GetDrillSize().y

    def GetDrillShape(self):
        k = _kid(self._node, "drill")
        if k is None:
            return PAD_DRILL_SHAPE_UNDEFINED
        return PAD_DRILL_SHAPE_OBLONG if any(str(c) == "oval" for c in k[1:] if not isinstance(c, list)) else PAD_DRILL_SHAPE_CIRCLE

    def HasHole(self):
        return self.GetDrillSize().x > 0

    def GetOffset(self, *_):
        k = _kid(self._node, "drill")
        o = _kid(k, "offset") if k is not None else None
        return VECTOR2I(FromMM(_f(o[1])), FromMM(_f(o[2]))) if o is not None and len(o) > 2 else VECTOR2I(0, 0)

    # ---- custom shapes: the polygons that, with the anchor, make up a custom pad

    def DeletePrimitivesList(self, *_):
        _drop_kid(self._node, "primitives")
        self._touch()

    def AddPrimitivePoly(self, *a):
        """AddPrimitivePoly([layer,] points, thickness, filled): one polygon, in the pad's own coordinates."""
        args = list(a[1:]) if (a and isinstance(a[0], int) and not isinstance(a[0], bool) and len(a) > 1 and not isinstance(a[1], (int, float))) else list(a)
        pts = args[0]
        if isinstance(pts, SHAPE_POLY_SET):
            pts = [pts.Outline(0).CPoint(i) for i in range(pts.Outline(0).PointCount())] if pts.OutlineCount() else []
        thickness = args[1] if len(args) > 1 else 0
        filled = bool(args[2]) if len(args) > 2 else True
        prim = _kid(self._node, "primitives")
        if prim is None:
            prim = [Sym("primitives")]
            self._node.append(prim)
        poly = [Sym("gr_poly"), [Sym("pts")] + [[Sym("xy"), _n(ToMM(VECTOR2I(p).x)), _n(ToMM(VECTOR2I(p).y))] for p in pts],
                [Sym("width"), _n(ToMM(int(thickness)))], [Sym("fill"), Sym("yes" if filled else "no")]]
        prim.append(poly)
        self._touch()

    def _add_primitive(self, node):
        prim = _kid(self._node, "primitives")
        if prim is None:
            prim = [Sym("primitives")]
            self._node.append(prim)
        prim.append(node)
        self._touch()

    def AddPrimitive(self, *a):
        """KiCad's own Python spellings: (points, width) a polygon; (start, end, width) a segment; (centre, radius,
        width) a circle; (centre, start, angle, width) an arc; (start, end, control 1, control 2, width) a curve."""
        import math
        xy = lambda name, p: [Sym(name), _n(ToMM(VECTOR2I(p).x)), _n(ToMM(VECTOR2I(p).y))]
        width = lambda w: [Sym("width"), _n(ToMM(int(w)))]
        if len(a) == 3 and isinstance(a[1], VECTOR2I):
            return self._add_primitive([Sym("gr_line"), xy("start", a[0]), xy("end", a[1]), width(a[2])])
        if len(a) == 3 and isinstance(a[0], VECTOR2I) and isinstance(a[1], (int, float)):
            c = VECTOR2I(a[0])
            return self._add_primitive([Sym("gr_circle"), xy("center", c), xy("end", VECTOR2I(c.x + int(a[1]), c.y)), width(a[2]), [Sym("fill"), Sym("no")]])
        if len(a) == 4 and isinstance(a[0], VECTOR2I) and isinstance(a[1], VECTOR2I):
            c, start = VECTOR2I(a[0]), VECTOR2I(a[1])
            deg = a[2].AsDegrees() if isinstance(a[2], EDA_ANGLE) else float(a[2]) / 10.0

            def turned(by):                      # as PCB_SHAPE.SetArcAngleAndEnd turns the start about the centre
                r = math.radians(by)
                dx, dy = start.x - c.x, start.y - c.y
                return VECTOR2I(int(round(c.x + dx * math.cos(r) - dy * math.sin(r))), int(round(c.y + dy * math.cos(r) + dx * math.sin(r))))
            first, last = (start, turned(deg)) if deg >= 0 else (turned(deg), start)
            return self._add_primitive([Sym("gr_arc"), xy("start", first), xy("mid", turned(deg / 2)), xy("end", last), width(a[3])])
        if len(a) == 5 and all(isinstance(p, VECTOR2I) for p in a[:4]):
            return self._add_primitive([Sym("gr_curve"), [Sym("pts")] + [xy("xy", p) for p in (a[0], a[2], a[3], a[1])], width(a[4])])
        self.AddPrimitivePoly(*a)

    def GetPrimitives(self):
        prim = _kid(self._node, "primitives")
        return [c for c in prim[1:] if isinstance(c, list)] if prim is not None else []

    def SetOffset(self, *a):
        o = VECTOR2I(*a)
        k = _kid(self._node, "drill")
        if k is None:
            if not (o.x or o.y):
                return
            k = _set_kid(self._node, "drill", 0)
        _drop_kid(k, "offset")
        if o.x or o.y:
            k.append([Sym("offset"), _n(ToMM(o.x)), _n(ToMM(o.y))])
        self._touch()

    def GetLayerSet(self):
        k = _kid(self._node, "layers")
        cu = self._board._copper_layers() if self._board is not None else None
        return LSET._from_names(k[1:], cu) if k is not None else LSET()

    def SetLayerSet(self, lset):
        _set_kid(self._node, "layers", *[_layer_name(l) for l in LSET(lset).Seq()])
        self._touch()

    def GetLayer(self):
        s = self.GetLayerSet()
        for l in (F_Cu, B_Cu):
            if l in s._s:
                return l
        seq = s.Seq()
        return seq[0] if seq else UNDEFINED_LAYER

    PTHMask = staticmethod(lambda: LSET.AllCuMask() | LSET([F_Mask, B_Mask]))
    SMDMask = staticmethod(lambda: LSET([F_Cu, F_Paste, F_Mask]))
    ConnSMDMask = staticmethod(lambda: LSET([F_Cu, F_Mask]))
    UnplatedHoleMask = staticmethod(lambda: LSET.AllCuMask() | LSET([F_Mask, B_Mask]))
    ApertureMask = staticmethod(lambda: LSET([F_Paste]))

    def GetPrincipalLayer(self):
        return self.GetLayer()

    def IsOnLayer(self, layer, *_):
        return int(layer) in self.GetLayerSet()._s

    def IsFlipped(self):
        return B_Cu in self.GetLayerSet()._s and F_Cu not in self.GetLayerSet()._s

    def GetPinFunction(self):
        k = _kid(self._node, "pinfunction")
        return str(k[1]) if k is not None and len(k) > 1 else ""

    def GetPinType(self):
        k = _kid(self._node, "pintype")
        return str(k[1]) if k is not None and len(k) > 1 else ""

    def GetRoundRectRadiusRatio(self, *_):
        k = _kid(self._node, "roundrect_rratio")
        return _f(k[1]) if k is not None and len(k) > 1 else 0.0

    def SetRoundRectRadiusRatio(self, *a):
        _set_kid(self._node, "roundrect_rratio", float(a[-1]))
        self._touch()

    def GetRoundRectCornerRadius(self, *_):
        s = self.GetSize()
        return int(min(s.x, s.y) * self.GetRoundRectRadiusRatio())

    def GetBoundingBox(self, *_):
        p, s = self.GetPosition(), self.GetSize()
        if self.GetOrientation().AsDegrees() % 180:
            s = VECTOR2I(s.y, s.x)
        return BOX2I._of(p.x - s.x // 2, p.y - s.y // 2, p.x + s.x // 2, p.y + s.y // 2)

    def GetBoundingRadius(self):
        s = self.GetSize()
        return int(_math.hypot(s.x, s.y) / 2)

    def GetCenter(self):
        return self.GetPosition()

    ShapePos = lambda self, *_: self.GetPosition()

    def GetSolderMaskExpansion(self, *_):
        k = _kid(self._node, "solder_mask_margin")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    GetLocalSolderMaskMargin = GetSolderMaskExpansion

    def GetLocalSolderPasteMargin(self):
        k = _kid(self._node, "solder_paste_margin")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    def _set_margin(self, name, v):
        if v:
            _set_kid(self._node, name, ToMM(v))
        else:
            _drop_kid(self._node, name)
        self._touch()

    def SetLocalSolderMaskMargin(self, v):
        self._set_margin("solder_mask_margin", v)

    def SetLocalSolderPasteMargin(self, v):
        self._set_margin("solder_paste_margin", v)

    def GetZoneConnection(self):
        k = _kid(self._node, "zone_connect")
        return int(_f(k[1])) if k is not None and len(k) > 1 else ZONE_CONNECTION_INHERITED

    GetLocalZoneConnection = GetZoneConnection

    def SetZoneConnection(self, v):
        _set_kid(self._node, "zone_connect", int(v))
        self._touch()

    SetLocalZoneConnection = SetZoneConnection

    def GetAnchorPadShape(self, *_):
        o = _kid(self._node, "options")
        c = _kid(o, "anchor") if o is not None else None
        return PAD_SHAPE_CIRCLE if c is not None and len(c) > 1 and str(c[1]) == "circle" else PAD_SHAPE_RECT

    def SetAnchorPadShape(self, *a):
        shape = a[-1] if a else PAD_SHAPE_RECT
        o = _kid(self._node, "options")
        if o is None:
            o = [Sym("options"), [Sym("clearance"), Sym("outline")], [Sym("anchor"), Sym("rect")]]
            self._node.append(o)
        _set_kid(o, "anchor", Sym("circle" if int(shape) == PAD_SHAPE_CIRCLE else "rect"))
        self._touch()

    def GetCustomShapeInZoneOpt(self):
        o = _kid(self._node, "options")
        c = _kid(o, "clearance") if o is not None else None
        return CUST_PAD_SHAPE_IN_ZONE_CONVEXHULL if c is not None and len(c) > 1 and str(c[1]) == "convexhull" else CUST_PAD_SHAPE_IN_ZONE_OUTLINE

    def SetCustomShapeInZoneOpt(self, opt):
        o = _kid(self._node, "options")
        if o is None:
            o = [Sym("options"), [Sym("clearance"), Sym("outline")], [Sym("anchor"), Sym("rect")]]
            self._node.append(o)
        _set_kid(o, "clearance", Sym("convexhull" if int(opt) == CUST_PAD_SHAPE_IN_ZONE_CONVEXHULL else "outline"))
        self._touch()

    def GetThermalSpokeWidth(self):
        k = _kid(self._node, "thermal_bridge_width") or _kid(self._node, "thermal_width")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    def GetThermalGap(self):
        k = _kid(self._node, "thermal_gap")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    def IsAperturePad(self):
        return not self.IsOnCopperLayer()

    def GetPadToDieLength(self):
        k = _kid(self._node, "die_length")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    def GetRemoveUnconnected(self):
        return _flag(self._node, "remove_unused_layers")

    def GetKeepTopBottom(self):
        return _flag(self._node, "keep_end_layers")

    def SameLogicalPadAs(self, other):
        return self.GetNumber() == other.GetNumber()

    def IsNoConnectPad(self):
        return self.GetPinType().endswith("no_connect")

    def BuildEffectivePolygon(self, *_a, **_k):
        """KiCad caches the pad's polygon here; this one is worked out each time it is asked for."""

    BuildEffectiveShapes = BuildEffectivePolygon

    def GetEffectivePolygon(self, *_a, **_k):
        """The pad's outline as a polygon: exact for rectangles, 24 sides for round ends."""
        p, s = self.GetPosition(), self.GetSize()
        rot = self.GetOrientation().AsDegrees()
        hx, hy = s.x / 2.0, s.y / 2.0
        shape = self.GetShape()
        if shape == PAD_SHAPE_CIRCLE:
            pts = [(hx * _math.cos(2 * _math.pi * i / 24), hx * _math.sin(2 * _math.pi * i / 24)) for i in range(24)]
        elif shape == PAD_SHAPE_OVAL:
            r = min(hx, hy)
            dx, dy = hx - r, hy - r
            pts = []
            for i in range(24):
                a = 2 * _math.pi * i / 24
                c, sn = _math.cos(a), _math.sin(a)
                pts.append((r * c + (dx if c >= 0 else -dx), r * sn + (dy if sn >= 0 else -dy)))
        else:
            pts = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
        out = SHAPE_POLY_SET()
        chain = SHAPE_LINE_CHAIN(closed=True)
        for x, y in pts:
            rx, ry = _rot(x, y, rot)
            chain.Append(VECTOR2I(p.x + rx, p.y + ry))
        out._outlines.append([chain])
        return out

    def Flip(self, centre, *_):
        _unsupported("PAD.Flip")




class FP_3DMODEL:
    def __init__(self, node=None):
        self._node = node or [Sym("model"), ""]

    @property
    def m_Filename(self):
        return str(self._node[1]) if len(self._node) > 1 else ""

    @m_Filename.setter
    def m_Filename(self, v):
        self._node[1] = str(v)
        fp = getattr(self, "_fp", None)
        if fp is not None:
            fp._touch()

    def _vec(self, name, default):
        k = _kid(self._node, name)
        xyz = _kid(k, "xyz") if k is not None else None
        return VECTOR3D(*[_f(c) for c in xyz[1:4]]) if xyz is not None and len(xyz) > 3 else VECTOR3D(*default)

    m_Offset = property(lambda self: self._vec("offset", (0, 0, 0)))
    m_Scale = property(lambda self: self._vec("scale", (1, 1, 1)))
    m_Rotation = property(lambda self: self._vec("rotate", (0, 0, 0)))
    m_Show = property(lambda self: not _flag(self._node, "hide"))
    m_Opacity = property(lambda self: _f((_kid(self._node, "opacity") or [0, 1])[1], 1.0))


class _ModelList(list):
    """A footprint's 3D models as KiCad hands them out: the footprint's own list, so taking one out, putting one in or
    clearing it changes the footprint (plugins pop every model, change its path and push it back)."""

    def __init__(self, fp):
        list.__init__(self, fp._kids()["models"])
        self._fp = fp

    def _sync(self):
        fp, node = self._fp, self._fp._node
        keep = [m._node for m in self]
        at = [i for i, k in enumerate(node) if isinstance(k, list) and k and str(k[0]) == "model"]
        where = at[0] if at else len(node)
        node[:] = [k for k in node[:where] if not (isinstance(k, list) and k and str(k[0]) == "model")] + keep + \
                  [k for k in node[where:] if not (isinstance(k, list) and k and str(k[0]) == "model")]
        fp._kids_cache = None
        fp._touch()

    def _changing(name):
        def call(self, *a, **k):
            out = getattr(list, name)(self, *a, **k)
            self._sync()
            return out
        call.__name__ = name
        return call

    for _m in ("append", "pop", "clear", "remove", "insert", "extend", "reverse", "__setitem__", "__delitem__"):
        locals()[_m] = _changing(_m)
    del _m, _changing

    def push_back(self, model):
        self.append(model)

    def pop_back(self):
        self.pop()

    def size(self):
        return len(self)

    def empty(self):
        return not self

    def front(self):
        return self[0]

    def back(self):
        return self[-1]


_FP_ATTR = {"through_hole": FP_THROUGH_HOLE, "smd": FP_SMD, "exclude_from_pos_files": FP_EXCLUDE_FROM_POS_FILES,
            "exclude_from_bom": FP_EXCLUDE_FROM_BOM, "board_only": FP_BOARD_ONLY, "allow_soldermask_bridges": FP_ALLOW_SOLDERMASK_BRIDGES,
            "allow_missing_courtyard": FP_ALLOW_MISSING_COURTYARD, "dnp": FP_DNP}
_FP_SHAPES = ("fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve")


class FOOTPRINT(BOARD_ITEM):
    """A footprint.  Where it sits (position, rotation, side) is changed through the editor's own
    move / rotate / flip, so pads, texts and courtyards follow exactly as they do for a person."""
    _TYPE, _CLASS, _TOKEN = PCB_FOOTPRINT_T, "FOOTPRINT", "footprint"

    def __init__(self, parent=None, *a):
        self._pending = None
        self._kids_cache = None
        BOARD_ITEM.__init__(self, parent)

    @classmethod
    def _wrap(cls, node, board, parent=None):
        self = super()._wrap(node, board, parent)
        self._pending = None
        self._kids_cache = None
        return self

    def _init_new(self):
        n = self._node
        n.extend(["", [Sym("layer"), "F.Cu"], [Sym("at"), _n(0), _n(0)]])
        BOARD_ITEM._init_new(self)

    # -- placement
    def _stored(self):
        k = _kid(self._node, "at")
        if k is None:
            return 0.0, 0.0, 0.0
        return _f(k[1]) if len(k) > 1 else 0.0, _f(k[2]) if len(k) > 2 else 0.0, _f(k[3]) if len(k) > 3 and not isinstance(k[3], list) else 0.0

    def _stored_rot(self):
        return self._stored()[2]

    def _stored_side(self):
        k = _kid(self._node, "layer")
        return "back" if k is not None and len(k) > 1 and str(k[1]) == "B.Cu" else "front"

    def _placement(self):
        """(x, y, rotation in degrees) in mm: what the plugin asked for if it moved the footprint, else what is stored."""
        p = self._pending
        if p:
            return p["x"], p["y"], p["rotation"]
        return self._stored()

    def _place(self, **kw):
        if self._pending is None:
            x, y, r = self._stored()
            self._pending = {"x": x, "y": y, "rotation": r, "side": self._stored_side()}
        self._pending.update(kw)
        self._touch()

    def GetPosition(self):
        x, y, _ = self._placement()
        return VECTOR2I(FromMM(x), FromMM(y))

    def SetPosition(self, *a):
        p = VECTOR2I(*a)
        self._place(x=ToMM(p.x), y=ToMM(p.y))

    def Move(self, *a):
        self.SetPosition(self.GetPosition() + VECTOR2I(*a))

    def GetOrientation(self):
        return EDA_ANGLE(self._placement()[2])

    def GetOrientationDegrees(self):
        return self._placement()[2]

    def GetOrientationRadians(self):
        return _math.radians(self._placement()[2])

    def SetOrientation(self, angle):
        d = _deg(angle) % 360.0
        self._place(rotation=d - 360.0 if d > 180.0 else d)

    def SetOrientationDegrees(self, d):
        self.SetOrientation(EDA_ANGLE(d))

    def Rotate(self, centre, angle):
        self.SetPosition(RotatePoint(VECTOR2I(self.GetPosition()), centre, angle))
        self.SetOrientation(EDA_ANGLE(self._placement()[2] + _deg(angle)))

    def GetLayer(self):
        side = self._pending["side"] if self._pending else self._stored_side()
        return B_Cu if side == "back" else F_Cu

    def GetSide(self):
        return self.GetLayer()

    def IsFlipped(self):
        return self.GetLayer() == B_Cu

    def SetLayer(self, layer):
        self._place(side="back" if int(layer) == B_Cu else "front")

    def SetLayerAndFlip(self, layer):
        self.SetLayer(layer)

    def Flip(self, centre=None, *_):
        if centre is not None:
            p = self.GetPosition()
            self._place(y=ToMM(2 * VECTOR2I(centre).y - p.y))
        self._place(side="front" if self.IsFlipped() else "back")

    def GetLayerSet(self):
        return LSET(self.GetLayer())

    # -- contents
    def _kids(self):
        c = self._kids_cache
        if c is None:
            c = {"pads": [], "texts": [], "shapes": [], "fields": [], "zones": [], "models": []}
            for n in self._node:
                if not isinstance(n, list) or not n:
                    continue
                t = n[0]
                if t == "pad":
                    c["pads"].append(PAD._wrap(n, self._board, self))
                elif t == "property" and len(n) > 2 and not isinstance(n[2], list) and _kid(n, "at") is not None:
                    c["fields"].append(PCB_FIELD._wrap(n, self._board, self))
                elif t == "fp_text":
                    kind = str(n[1]) if len(n) > 1 else ""
                    if kind in ("reference", "value"):
                        c["fields"].append(_LegacyFieldText._wrap(n, self._board, self))
                    else:
                        c["texts"].append(PCB_TEXT._wrap(n, self._board, self))
                elif t in _FP_SHAPES:
                    c["shapes"].append(PCB_SHAPE._wrap(n, self._board, self))
                elif t == "zone":
                    c["zones"].append(ZONE._wrap(n, self._board, self))
                elif t == "model":
                    m = FP_3DMODEL(n)
                    m._fp = self
                    c["models"].append(m)
            self._kids_cache = c
        return c

    def Pads(self):
        return list(self._kids()["pads"])

    def GetPads(self, *_):
        return self.Pads()

    def GetPadCount(self, *_):
        return len(self._kids()["pads"])

    def FindPadByNumber(self, number, *_):
        for p in self._kids()["pads"]:
            if p.GetNumber() == str(number):
                return p
        return None

    FindPadByName = FindPadByNumber

    def GetFirstPad(self):
        pads = self._kids()["pads"]
        return pads[0] if pads else None

    def MoveAnchorPosition(self, *a):
        """Shift everything the footprint holds by this much, so its own origin lands elsewhere on it."""
        d = VECTOR2I(*a)
        for item in list(self.Pads()) + list(self.GraphicalItems()) + list(self.GetFields()):
            item.Move(d)

    def GraphicalItems(self):
        k = self._kids()
        return list(k["shapes"]) + list(k["texts"])

    def Zones(self):
        return list(self._kids()["zones"])

    def Models(self):
        return _ModelList(self)

    def Add3DModel(self, model):
        self.Models().push_back(model)

    def Groups(self):
        return []

    def Fields(self):
        return list(self._kids()["fields"])

    def GetFields(self, *_):
        return self.Fields()

    def _field(self, name):
        for f in self._kids()["fields"]:
            if f.GetName() == name:
                return f
        return None

    def GetFieldByName(self, name):
        return self._field(str(name))

    def GetField(self, which):
        if isinstance(which, int):
            which = {0: "Reference", 1: "Value", 2: "Footprint", 3: "Datasheet", 4: "Description"}.get(which, "")
        return self._field(str(which))

    def HasFieldByName(self, name):
        return self._field(str(name)) is not None

    HasField = HasFieldByName

    def GetFieldText(self, name):
        f = self._field(str(name))
        return f.GetText() if f is not None else ""

    def GetFieldsText(self):
        return {f.GetName(): f.GetText() for f in self._kids()["fields"]}

    def GetFieldsShownText(self):
        return {f.GetName(): f.GetShownText() for f in self._kids()["fields"]}

    def GetProperties(self):
        return {f.GetName(): f.GetText() for f in self._kids()["fields"] if not f.IsMandatory()}

    def HasProperty(self, name):
        return self._field(str(name)) is not None

    def GetProperty(self, name):
        # KiCad 7 kept the schematic sheet a footprint came from as properties; later versions as their own entries.
        f = self._field(str(name))
        if f is not None:
            return f.GetText()
        low = str(name).lower()
        if low in ("sheetfile", "sheetname"):
            v = self._text_kid(low)
            if v:
                return v
        raise KeyError(name)

    def SetField(self, name, text):
        f = self._field(str(name))
        if f is None:
            f = PCB_FIELD(self, 0, str(name))
            self._node.append(f._node)
            self._kids_cache = None
        f.SetText(text)

    SetProperty = SetField

    def AddField(self, field):
        self._node.append(field._node)
        field._parent, field._board = self, self._board
        self._kids_cache = None
        self._touch()
        return field

    def RemoveField(self, name):
        f = self._field(str(name))
        if f is not None:
            self._node.remove(f._node)
            self._kids_cache = None
            self._touch()

    def Reference(self):
        f = self._field("Reference")
        if f is None:
            self.SetField("Reference", "REF**")
            f = self._field("Reference")
        return f

    def Value(self):
        f = self._field("Value")
        if f is None:
            self.SetField("Value", "")
            f = self._field("Value")
        return f

    def GetReference(self):
        f = self._field("Reference")
        return f.GetText() if f is not None else ""

    GetReferenceAsString = GetReference

    def SetReference(self, ref):
        self.Reference().SetText(ref)

    def GetValue(self):
        f = self._field("Value")
        return f.GetText() if f is not None else ""

    GetValueAsString = GetValue

    def SetValue(self, value):
        self.Value().SetText(value)

    def GetFPID(self):
        return LIB_ID(str(self._node[1]) if len(self._node) > 1 and not isinstance(self._node[1], list) else "")

    def SetFPID(self, fpid):
        self._node[1] = str(fpid)
        self._touch()

    def GetFPIDAsString(self):
        return self.GetFPID().Format()

    def SetFPIDAsString(self, s):
        self.SetFPID(s)

    def _text_kid(self, name):
        k = _kid(self._node, name)
        return str(k[1]) if k is not None and len(k) > 1 else ""

    def GetDescription(self):
        return self._text_kid("descr") or self.GetFieldText("Description")

    GetLibDescription = GetDescription

    def SetDescription(self, text):
        _set_kid(self._node, "descr", str(text))
        self._touch()

    SetLibDescription = SetDescription

    def GetKeywords(self):
        return self._text_kid("tags")

    def SetKeywords(self, text):
        _set_kid(self._node, "tags", str(text))
        self._touch()

    def GetPath(self):
        return KIID_PATH(self._text_kid("path"))

    def SetPath(self, path):
        _set_kid(self._node, "path", str(path))
        self._touch()

    def GetSheetname(self):
        return self._text_kid("sheetname")

    def GetSheetfile(self):
        return self._text_kid("sheetfile")

    def GetLink(self):
        return KIID(self._text_kid("uuid"))

    def _attr_words(self):
        k = _kid(self._node, "attr")
        return [str(c) for c in k[1:]] if k is not None else []

    def GetAttributes(self):
        v = 0
        for w in self._attr_words():
            v |= _FP_ATTR.get(w, 0)
        return v

    def SetAttributes(self, value):
        words = [w for w, bit in _FP_ATTR.items() if value & bit]
        if words:
            k = _kid(self._node, "attr")
            if k is None:
                k = [Sym("attr")]
                self._node.append(k)
            k[:] = [Sym("attr")] + [Sym(w) for w in words]
        else:
            _drop_kid(self._node, "attr")
        self._touch()

    def _set_attr(self, bit, on):
        v = self.GetAttributes()
        self.SetAttributes((v | bit) if on else (v & ~bit))

    def IsDNP(self):
        return bool(self.GetAttributes() & FP_DNP)

    GetDNP = IsDNP

    def SetDNP(self, on=True):
        self._set_attr(FP_DNP, on)

    def IsExcludedFromBOM(self):
        return bool(self.GetAttributes() & FP_EXCLUDE_FROM_BOM)

    def SetExcludedFromBOM(self, on=True):
        self._set_attr(FP_EXCLUDE_FROM_BOM, on)

    def IsExcludedFromPosFiles(self):
        return bool(self.GetAttributes() & FP_EXCLUDE_FROM_POS_FILES)

    def SetExcludedFromPosFiles(self, on=True):
        self._set_attr(FP_EXCLUDE_FROM_POS_FILES, on)

    def IsBoardOnly(self):
        return bool(self.GetAttributes() & FP_BOARD_ONLY)

    def SetBoardOnly(self, on=True):
        self._set_attr(FP_BOARD_ONLY, on)

    def GetTypeName(self):
        a = self.GetAttributes()
        return "SMD" if a & FP_SMD else ("Through hole" if a & FP_THROUGH_HOLE else "Other")

    def Add(self, item, *_):
        self._node.append(item._node)
        item._parent, item._board = self, self._board
        self._kids_cache = None
        self._touch()

    def Remove(self, item, *_):
        if item._node in self._node:
            self._node.remove(item._node)
            self._kids_cache = None
            self._touch()

    Delete = Remove
    AddNative, RemoveNative = Add, Remove

    def _local_box(self, include_text=False):
        """Bounding box in board coordinates of the pads and drawn shapes."""
        b = BOX2I()
        k = self._kids()
        for p in k["pads"]:
            b.Merge(p.GetBoundingBox())
        for s in k["shapes"]:
            if s.GetLayer() not in (F_CrtYd, B_CrtYd) or not k["pads"]:
                b.Merge(s.GetBoundingBox())
        if include_text:
            for t in k["texts"] + k["fields"]:
                if t.IsVisible():
                    b.Merge(t.GetBoundingBox())
        if not b._valid:
            b = BOX2I(self.GetPosition(), VECTOR2I(0, 0))
        return b

    def GetBoundingBox(self, *a):
        return self._local_box(bool(a[0]) if a else True)

    def GetFootprintRect(self):
        return self._local_box(False)

    def GetBoundingHull(self):
        b = self._local_box(False)
        s = SHAPE_POLY_SET()
        s._outlines.append([SHAPE_LINE_CHAIN([b.GetOrigin(), VECTOR2I(b.GetRight(), b.GetTop()), b.GetEnd(), VECTOR2I(b.GetLeft(), b.GetBottom())], True)])
        return s

    def GetCourtyard(self, layer):
        s = SHAPE_POLY_SET()
        for sh in self._kids()["shapes"]:
            if sh.GetLayer() == int(layer) and sh._kind() in ("poly", "rect"):
                s._outlines.append([SHAPE_LINE_CHAIN(sh.GetCorners(), True)])
        return s

    def GetArea(self, *_):
        return float(self._local_box(False).GetArea())

    def GetCenter(self):
        return self._local_box(False).GetCenter()

    def HitTest(self, pos, accuracy=0, *_):
        return BOX2I(self._local_box(False).GetOrigin(), self._local_box(False).GetSize()).Inflate(accuracy).Contains(pos)

    def GetUniquePadCount(self, *_):
        return len({p.GetNumber() for p in self._kids()["pads"] if p.GetNumber()})

    def GetUniquePadNumbers(self, *_):
        return sorted({p.GetNumber() for p in self._kids()["pads"] if p.GetNumber()})

    def GetNextPadNumber(self, last=""):
        return str(len(self._kids()["pads"]) + 1)

    def IsPlaced(self):
        return True

    def NeedsPlaced(self):
        return False

    def HasThroughHolePads(self):
        return any(p.GetAttribute() == PAD_ATTRIB_PTH for p in self._kids()["pads"])

    def IsNetTie(self):
        return _kid(self._node, "net_tie_pad_groups") is not None

    def GetNetTiePadGroups(self):
        k = _kid(self._node, "net_tie_pad_groups")
        return [str(g) for g in k[1:]] if k is not None else []

    def AddNetTiePadGroup(self, group):
        """Pads that may touch although they are on different nets: one group is a list of pad numbers, "1, 2"."""
        k = _kid(self._node, "net_tie_pad_groups")
        if k is None:
            k = [Sym("net_tie_pad_groups")]
            self._node.append(k)
        k.append(str(group))
        self._touch()

    def ClearNetTiePadGroups(self):
        k = _kid(self._node, "net_tie_pad_groups")
        if k is not None:
            self._node.remove(k)
            self._touch()

    def MapPadNumbersToNetTieGroups(self):
        out = {}
        for i, g in enumerate(self.GetNetTiePadGroups()):
            for n in g.split(","):
                out[n.strip()] = i
        return out

    def GetFriendlyName(self):
        return "Footprint"

    def GetClearanceOverrides(self, *_):
        return 0

    def GetLocalClearance(self, *_):
        k = _kid(self._node, "clearance")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    def SetLocalClearance(self, v):
        if v:
            _set_kid(self._node, "clearance", ToMM(v))
        else:
            _drop_kid(self._node, "clearance")
        self._touch()

    def GetZoneConnection(self):
        k = _kid(self._node, "zone_connect")
        return int(_f(k[1])) if k is not None and len(k) > 1 else ZONE_CONNECTION_INHERITED

    GetLocalZoneConnection = GetZoneConnection

    def SetZoneConnection(self, v):
        if v is None or int(v) == ZONE_CONNECTION_INHERITED:
            _drop_kid(self._node, "zone_connect")
        else:
            _set_kid(self._node, "zone_connect", int(v))
        self._touch()

    SetLocalZoneConnection = SetZoneConnection

    def SetLocalSolderPasteMarginRatio(self, v):
        _drop_kid(self._node, "solder_paste_ratio")
        if v:
            _set_kid(self._node, "solder_paste_margin_ratio", float(v))
        else:
            _drop_kid(self._node, "solder_paste_margin_ratio")
        self._touch()

    def GetLocalSolderMaskMargin(self):
        k = _kid(self._node, "solder_mask_margin")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    def SetLocalSolderMaskMargin(self, v):
        if v:
            _set_kid(self._node, "solder_mask_margin", ToMM(v))
        else:
            _drop_kid(self._node, "solder_mask_margin")
        self._touch()

    def SetLocalSolderPasteMargin(self, v):
        if v:
            _set_kid(self._node, "solder_paste_margin", ToMM(v))
        else:
            _drop_kid(self._node, "solder_paste_margin")
        self._touch()

    def GetLocalSolderPasteMargin(self):
        k = _kid(self._node, "solder_paste_margin")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else 0

    def GetLocalSolderPasteMarginRatio(self):
        k = _kid(self._node, "solder_paste_margin_ratio") or _kid(self._node, "solder_paste_ratio")
        return _f(k[1]) if k is not None and len(k) > 1 else 0.0

    def __repr__(self):
        return f"<FOOTPRINT {self.GetReference()}>"




class ZONE(BOARD_CONNECTED_ITEM):
    _TYPE, _CLASS, _TOKEN = PCB_ZONE_T, "ZONE", "zone"

    def _init_new(self):
        n = self._node
        n.extend([[Sym("net"), _n(0)], [Sym("net_name"), ""], [Sym("layer"), "F.Cu"], [Sym("hatch"), Sym("edge"), _n(0.5)],
                  [Sym("connect_pads"), [Sym("clearance"), _n(0.5)]], [Sym("min_thickness"), _n(0.25)],
                  [Sym("fill"), [Sym("thermal_gap"), _n(0.5)], [Sym("thermal_bridge_width"), _n(0.5)]],
                  [Sym("polygon"), [Sym("pts")]]])
        BOARD_ITEM._init_new(self)

    def _net_name(self):
        k = _kid(self._node, "net_name")
        if k is not None and len(k) > 1:
            return str(k[1])
        return super()._net_name()

    def _write_net(self, name):
        b = self._board
        if b is not None and b._nets_by_name_only:
            _set_kid(self._node, "net", name)
        else:
            _set_kid(self._node, "net", b._net_code(name, create=True) if b is not None else 0)
            _set_kid(self._node, "net_name", name)
        self._touch()

    def GetZoneName(self):
        k = _kid(self._node, "name")
        return str(k[1]) if k is not None and len(k) > 1 else ""

    def SetZoneName(self, name):
        _set_kid(self._node, "name", str(name))
        self._touch()

    def GetLayerSet(self):
        k = _kid(self._node, "layers")
        if k is not None:
            return LSET._from_names(k[1:], self._board._copper_layers() if self._board is not None else None)
        k = _kid(self._node, "layer")
        return LSET(_layer_id(k[1])) if k is not None and len(k) > 1 else LSET()

    def SetLayerSet(self, lset):
        names = [_layer_name(l) for l in LSET(lset).Seq()]
        _drop_kid(self._node, "layer")
        _drop_kid(self._node, "layers")
        if len(names) == 1:
            self._node.insert(1, [Sym("layer"), names[0]])
        else:
            self._node.insert(1, [Sym("layers")] + names)
        self._touch()

    def GetLayer(self):
        seq = self.GetLayerSet().Seq()
        return seq[0] if seq else UNDEFINED_LAYER

    GetFirstLayer = GetLayer

    def SetLayer(self, layer):
        self.SetLayerSet(LSET(layer))

    def IsOnLayer(self, layer, *_):
        return int(layer) in self.GetLayerSet()._s

    def _polygon(self):
        return _kid(self._node, "polygon")

    def _touch(self):
        self.__dict__["_rev"] = self.__dict__.get("_rev", 0) + 1
        BOARD_ITEM._touch(self)

    def Outline(self):
        live = self.__dict__.get("_live")
        if live is not None and live[0] == self.__dict__.get("_rev", 0) and live[2] is self._node:
            return live[1]
        s = _ZoneOutline()
        s._zone = self
        for poly in _kids(self._node, "polygon"):
            pts = _pts_of(poly, self._to_board)
            if pts:
                s._outlines.append([SHAPE_LINE_CHAIN(pts, True)])
        self.__dict__["_live"] = (self.__dict__.get("_rev", 0), s, self._node)
        return s

    def SetOutline(self, poly):
        self._node[:] = [c for c in self._node if not (isinstance(c, list) and c and c[0] == "polygon")]
        for pts in poly._to_nodes(self._to_local):
            self._node.append([Sym("polygon"), pts])
        self._touch()

    def GetNumCorners(self):
        return self.Outline().TotalVertices()

    def GetCornerPosition(self, i):
        return self.Outline().CVertex(i)

    def SetCornerPosition(self, i, pos):
        o = self.Outline()
        for outline in o._outlines:
            c = outline[0]
            if i < c.PointCount():
                c.SetPoint(i, pos)
                break
            i -= c.PointCount()
        self.SetOutline(o)

    def AppendCorner(self, pos, hole=-1, *_):
        o = self.Outline()
        if not o._outlines:
            o.NewOutline()
        o._outlines[-1][0].Append(VECTOR2I(pos))
        self.SetOutline(o)
        return True

    def AddPolygon(self, points):
        o = self.Outline()
        o._outlines.append([SHAPE_LINE_CHAIN(list(points), True)])
        self.SetOutline(o)

    def GetPosition(self):
        o = self.Outline()
        return o.CVertex(0) if o.TotalVertices() else VECTOR2I(0, 0)

    def Move(self, *a):
        d = VECTOR2I(*a)
        o = self.Outline()
        o.Move(d)
        self.SetOutline(o)
        self._unfill()

    def SetPosition(self, *a):
        self.Move(VECTOR2I(*a) - self.GetPosition())

    def Rotate(self, centre, angle):
        o = self.Outline()
        o.Rotate(angle, centre)
        self.SetOutline(o)
        self._unfill()

    def Flip(self, centre, *_):
        cy = VECTOR2I(centre).y
        o = self.Outline()
        for outline in o._outlines:
            for c in outline:
                c._pts = [VECTOR2I(p.x, 2 * cy - p.y) for p in c._pts]
        self.SetOutline(o)
        self.SetLayerSet(LSET([FlipLayer(l) for l in self.GetLayerSet()._s]))
        self._unfill()

    def GetBoundingBox(self, *_):
        return self.Outline().BBox()

    def _unfill(self):
        self._node[:] = [c for c in self._node if not (isinstance(c, list) and c and c[0] in ("filled_polygon", "fill_segments"))]
        f = _kid(self._node, "fill")
        if f is not None:
            f[:] = [c for c in f if not (isinstance(c, Sym) and c == "yes" and c is not f[0])]
        self._touch()

    def UnFill(self):
        self._unfill()
        return True

    def IsFilled(self):
        return _kid(self._node, "filled_polygon") is not None

    def SetIsFilled(self, on):
        if not on:
            self._unfill()

    def SetNeedRefill(self, on=True):
        pass

    def NeedRefill(self):
        return not self.IsFilled()

    def _fill_of(self, layer):
        """The fill on a layer, read once and kept until the zone's fill changes (a fill is thousands of points and
        plugins ask about it point by point)."""
        fills = [fp for fp in _kids(self._node, "filled_polygon")]
        stamp = (self.__dict__.get("_rev", 0), id(self._node)) + tuple((id(fp), len(fp), id(_kid(fp, "pts"))) for fp in fills)
        cache = self.__dict__.setdefault("_fill_cache", {})
        hit = cache.get(int(layer))
        if hit is not None and hit[0] == stamp:
            return hit[1]
        s = SHAPE_POLY_SET()
        for fp in fills:
            lk = _kid(fp, "layer")
            if lk is None or _layer_id(lk[1]) == int(layer):
                pts = _pts_of(fp, self._to_board)
                if pts:
                    s._outlines.append([SHAPE_LINE_CHAIN(pts, True)])
        cache[int(layer)] = (stamp, s)
        return s

    def GetFilledPolysList(self, layer):
        return SHAPE_POLY_SET(self._fill_of(layer))         # the caller's own copy, as on the desktop

    GetFill = GetFilledPolysList

    def GetFilledArea(self):
        return sum(self.GetFilledPolysList(l).Area() for l in self.GetLayerSet()._s)

    def HitTestForCorner(self, pos, accuracy=0, *_):
        """True when `pos` is within `accuracy` of an outline corner (KiCad also reports which one)."""
        p = VECTOR2I(pos)
        acc = max(int(accuracy or 0), 1)
        return any(abs(c.x - p.x) <= acc and abs(c.y - p.y) <= acc for c in [self.GetCornerPosition(i) for i in range(self.GetNumCorners())])

    def HitTestForEdge(self, pos, accuracy=0, *_):
        """True when `pos` is within `accuracy` of an outline edge."""
        import math as _m
        p = VECTOR2I(pos)
        acc = max(int(accuracy or 0), 1)
        pts = [self.GetCornerPosition(i) for i in range(self.GetNumCorners())]
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            dx, dy = b.x - a.x, b.y - a.y
            L = dx * dx + dy * dy
            t = max(0.0, min(1.0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) if L else 0.0
            if _m.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= acc:
                return True
        return False

    def HitTestFilledArea(self, layer, pos, *_):
        return self._fill_of(layer).Contains(pos)

    def HitTestInsideZone(self, pos, *_):
        return self.Outline().Contains(pos)

    HitTest = lambda self, pos, *_: self.Outline().Contains(pos) if not isinstance(pos, BOX2I) else pos.Intersects(self.GetBoundingBox())

    def GetIsRuleArea(self):
        return _kid(self._node, "keepout") is not None

    def SetIsRuleArea(self, on):
        if on and _kid(self._node, "keepout") is None:
            self._node.append([Sym("keepout"), [Sym("tracks"), Sym("allowed")], [Sym("vias"), Sym("allowed")], [Sym("pads"), Sym("allowed")],
                               [Sym("copperpour"), Sym("not_allowed")], [Sym("footprints"), Sym("allowed")]])
        elif not on:
            _drop_kid(self._node, "keepout")
        self._touch()

    def _keepout(self, what):
        k = _kid(self._node, "keepout")
        w = _kid(k, what) if k is not None else None
        return w is not None and len(w) > 1 and str(w[1]) == "not_allowed"

    def _set_keepout(self, what, on):
        self.SetIsRuleArea(True)
        _set_kid(_kid(self._node, "keepout"), what, Sym("not_allowed" if on else "allowed"))
        self._touch()

    GetDoNotAllowTracks = lambda self: self._keepout("tracks")
    GetDoNotAllowVias = lambda self: self._keepout("vias")
    GetDoNotAllowPads = lambda self: self._keepout("pads")
    GetDoNotAllowCopperPour = lambda self: self._keepout("copperpour")
    GetDoNotAllowFootprints = lambda self: self._keepout("footprints")
    GetDoNotAllowZoneFills = GetDoNotAllowCopperPour
    SetDoNotAllowTracks = lambda self, on: self._set_keepout("tracks", on)
    SetDoNotAllowVias = lambda self, on: self._set_keepout("vias", on)
    SetDoNotAllowPads = lambda self, on: self._set_keepout("pads", on)
    SetDoNotAllowCopperPour = lambda self, on: self._set_keepout("copperpour", on)
    SetDoNotAllowFootprints = lambda self, on: self._set_keepout("footprints", on)
    SetDoNotAllowZoneFills = SetDoNotAllowCopperPour

    def GetAssignedPriority(self):
        k = _kid(self._node, "priority")
        return int(_f(k[1])) if k is not None and len(k) > 1 else 0

    GetPriority = GetAssignedPriority

    def SetAssignedPriority(self, p):
        _set_kid(self._node, "priority", int(p))
        self._touch()

    SetPriority = SetAssignedPriority

    def GetMinThickness(self):
        k = _kid(self._node, "min_thickness")
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else FromMM(0.25)

    def SetMinThickness(self, v):
        _set_kid(self._node, "min_thickness", ToMM(v))
        self._touch()

    def _connect(self, create=False):
        k = _kid(self._node, "connect_pads")
        if k is None and create:
            k = [Sym("connect_pads"), [Sym("clearance"), _n(0.5)]]
            self._node.append(k)
        return k

    def GetLocalClearance(self, *_):
        k = self._connect()
        c = _kid(k, "clearance") if k is not None else None
        return FromMM(_f(c[1])) if c is not None and len(c) > 1 else 0

    def SetLocalClearance(self, v):
        _set_kid(self._connect(True), "clearance", ToMM(v))
        self._touch()

    def GetPadConnection(self, *_):
        k = self._connect()
        words = [str(c) for c in k[1:] if isinstance(c, Sym)] if k is not None else []
        return {"no": ZONE_CONNECTION_NONE, "yes": ZONE_CONNECTION_FULL, "thru_hole_only": ZONE_CONNECTION_THT_THERMAL}.get(words[0] if words else "", ZONE_CONNECTION_THERMAL)

    def SetPadConnection(self, mode):
        k = self._connect(True)
        k[:] = [c for c in k if not (isinstance(c, Sym) and c is not k[0])]
        word = {ZONE_CONNECTION_NONE: "no", ZONE_CONNECTION_FULL: "yes", ZONE_CONNECTION_THT_THERMAL: "thru_hole_only"}.get(mode)
        if word:
            k.insert(1, Sym(word))
        self._touch()

    def _fill(self, create=False):
        k = _kid(self._node, "fill")
        if k is None and create:
            k = [Sym("fill")]
            self._node.append(k)
        return k

    def _fill_num(self, name, default):
        k = self._fill()
        c = _kid(k, name) if k is not None else None
        return FromMM(_f(c[1])) if c is not None and len(c) > 1 else FromMM(default)

    def GetThermalReliefGap(self, *_):
        return self._fill_num("thermal_gap", 0.5)

    def SetThermalReliefGap(self, v):
        _set_kid(self._fill(True), "thermal_gap", ToMM(v))
        self._touch()

    def GetThermalReliefSpokeWidth(self):
        return self._fill_num("thermal_bridge_width", 0.5)

    def SetThermalReliefSpokeWidth(self, v):
        _set_kid(self._fill(True), "thermal_bridge_width", ToMM(v))
        self._touch()

    def GetIslandRemovalMode(self):
        k = self._fill()
        c = _kid(k, "island_removal_mode") if k is not None else None
        return int(_f(c[1])) if c is not None and len(c) > 1 else ISLAND_REMOVAL_MODE_ALWAYS

    def SetIslandRemovalMode(self, mode):
        _set_kid(self._fill(True), "island_removal_mode", int(mode))
        self._touch()

    def GetMinIslandArea(self):
        return self._fill_num("island_area_min", 0)

    def SetMinIslandArea(self, v):
        _set_kid(self._fill(True), "island_area_min", ToMM(v))
        self._touch()

    def GetFillMode(self):
        k = self._fill()
        c = _kid(k, "mode") if k is not None else None
        return ZONE_FILL_MODE_HATCH_PATTERN if c is not None and len(c) > 1 and str(c[1]) == "hatch" else ZONE_FILL_MODE_POLYGONS

    def SetFillMode(self, mode):
        f = self._fill(True)
        if mode == ZONE_FILL_MODE_HATCH_PATTERN:
            _set_kid(f, "mode", Sym("hatch"))
        else:
            _drop_kid(f, "mode")
        self._touch()

    def GetHatchThickness(self):
        return self._fill_num("hatch_thickness", 0)

    def SetHatchThickness(self, v):
        _set_kid(self._fill(True), "hatch_thickness", ToMM(v))
        self._touch()

    def GetHatchGap(self):
        return self._fill_num("hatch_gap", 0)

    def SetHatchGap(self, v):
        _set_kid(self._fill(True), "hatch_gap", ToMM(v))
        self._touch()

    def GetHatchOrientation(self):
        k = self._fill()
        c = _kid(k, "hatch_orientation") if k is not None else None
        return EDA_ANGLE(_f(c[1]) if c is not None and len(c) > 1 else 0.0, DEGREES_T)

    def SetHatchOrientation(self, angle):
        _set_kid(self._fill(True), "hatch_orientation", _n(_deg(angle)))
        self._touch()

    def GetHatchStyle(self):
        k = _kid(self._node, "hatch")
        return {"none": 0, "full": 1, "edge": 2}.get(str(k[1]) if k is not None and len(k) > 1 else "edge", 2)

    def SetHatchStyle(self, style):
        k = _kid(self._node, "hatch")
        pitch = k[2] if k is not None and len(k) > 2 else _n(0.5)
        _set_kid(self._node, "hatch", Sym({0: "none", 1: "full", 2: "edge"}.get(style, "edge")), pitch)
        self._touch()

    def SetBorderDisplayStyle(self, style, pitch=None, *_):
        self.SetHatchStyle(style)

    GetHatchBorderDisplayStyle = GetHatchStyle

    def HatchBorder(self):
        pass

    def UnHatchBorder(self):
        pass

    def BuildSmoothedPoly(self, *_):
        return self.Outline()

    def CacheBoundingBox(self):
        pass

    def IsTeardropArea(self):
        return _kid(self._node, "attr") is not None and "teardrop" in _dump(_kid(self._node, "attr"))

    def GetCornerRadius(self):
        return 0

    def GetCornerSmoothingType(self):
        return 0

    def SetCornerSmoothingType(self, *_):
        pass

    def SetCornerRadius(self, *_):
        pass

    def NewHole(self):
        pass

    def RemoveAllContours(self):
        self.SetOutline(SHAPE_POLY_SET())




class PCB_GROUP(BOARD_ITEM):
    _TYPE, _CLASS, _TOKEN = PCB_GROUP_T, "PCB_GROUP", "group"

    def _init_new(self):
        self._node.extend(["", [Sym("members")]])
        BOARD_ITEM._init_new(self)

    def GetName(self):
        return str(self._node[1]) if len(self._node) > 1 and not isinstance(self._node[1], list) else ""

    def SetName(self, name):
        if len(self._node) > 1 and not isinstance(self._node[1], list):
            self._node[1] = str(name)
        else:
            self._node.insert(1, str(name))
        self._touch()

    def _member_ids(self):
        k = _kid(self._node, "members")
        return [str(c) for c in k[1:]] if k is not None else []

    def GetItems(self):
        b = self._board
        if b is None:
            return []
        return [b._by_id[i] for i in self._member_ids() if i in b._by_id]

    def AddItem(self, item):
        k = _kid(self._node, "members")
        if k is None:
            k = [Sym("members")]
            self._node.append(k)
        uid = item.m_Uuid.AsString()
        if uid not in [str(c) for c in k[1:]]:
            k.append(uid)
            self._touch()
        return True

    def RemoveItem(self, item):
        k = _kid(self._node, "members")
        uid = item.m_Uuid.AsString()
        if k is not None:
            k[:] = [c for c in k if str(c) != uid or c is k[0]]
            self._touch()
        return True

    def RemoveAll(self):
        _set_kid(self._node, "members")
        self._touch()

    def GetBoundingBox(self, *_):
        b = BOX2I()
        for it in self.GetItems():
            b.Merge(it.GetBoundingBox())
        return b

    def GetPosition(self):
        return self.GetBoundingBox().GetOrigin()

    def Move(self, *a):
        for it in self.GetItems():
            it.Move(*a)

    # KiCad 10: a group is an EDA_GROUP, its members are named by id
    def GetGroupMemberIds(self):
        return [KIID(i) for i in self._member_ids()]

    AsEdaItem = lambda self: self


EDA_GROUP = PCB_GROUP


class PCB_DIMENSION_BASE(BOARD_ITEM):
    """A dimension, in the board file's own form: two measured points, a height, format and style blocks,
    and the text KiCad shows (kept up to date here the way KiCad updates it)."""
    _TYPE, _CLASS, _TOKEN = PCB_DIMENSION_T, "PCB_DIMENSION", "dimension"
    _KIND = "aligned"
    DIR_HORIZONTAL, DIR_VERTICAL = 0, 1

    def _init_new(self):
        n = self._node
        n.extend([[Sym("type"), Sym(self._KIND)], [Sym("layer"), "Dwgs.User"]])
        BOARD_ITEM._init_new(self)
        n.extend([
            [Sym("pts"), [Sym("xy"), _n(0), _n(0)], [Sym("xy"), _n(0), _n(0)]],
            [Sym("height"), _n(0)],
            [Sym("format"), [Sym("prefix"), ""], [Sym("suffix"), ""], [Sym("units"), _n(3)], [Sym("units_format"), _n(1)], [Sym("precision"), _n(4)]],
            [Sym("style"), [Sym("thickness"), _n(0.1)], [Sym("arrow_length"), _n(1.27)], [Sym("text_position_mode"), _n(0)],
             [Sym("extension_height"), _n(0.58642)], [Sym("extension_offset"), _n(0.5)], Sym("keep_text_aligned")],
            [Sym("gr_text", ), "0", [Sym("at"), _n(0), _n(0)], [Sym("layer"), "Dwgs.User"], [Sym("uuid"), str(_uuid.uuid4())],
             [Sym("effects"), [Sym("font"), [Sym("size"), _n(1), _n(1)], [Sym("thickness"), _n(0.15)]]]],
        ])
        if self._KIND == "orthogonal":
            n.insert(n.index(_kid(n, "format")), [Sym("orientation"), _n(0)])

    # ---- the two measured points
    def _points(self):
        return _pts_of(self._node, self._to_board)

    def _set_point(self, i, a):
        p = VECTOR2I(*a)
        pts = _kid(self._node, "pts")
        if pts is None:
            pts = _set_kid(self._node, "pts")
        while len(pts) < 3:
            pts.append([Sym("xy"), _n(0), _n(0)])
        pts[1 + i] = [Sym("xy"), _n(ToMM(p.x)), _n(ToMM(p.y))]
        self._update()

    def GetBoundingBox(self, *_):
        b = BOX2I()
        for p in self._points() + [self._crossbar(0), self._crossbar(1)]:
            b.Merge(p)
        return b

    def GetPosition(self):
        pts = self._points()
        return pts[0] if pts else VECTOR2I(0, 0)

    def GetStart(self):
        return self.GetPosition()

    def GetEnd(self):
        pts = self._points()
        return pts[1] if len(pts) > 1 else VECTOR2I(0, 0)

    def SetStart(self, *a):
        self._set_point(0, a)

    def SetEnd(self, *a):
        self._set_point(1, a)

    def SetPosition(self, *a):
        p = VECTOR2I(*a)
        o = self.GetPosition()
        self.Move(VECTOR2I(p.x - o.x, p.y - o.y))

    def Move(self, *a):
        d = VECTOR2I(*a)
        s, e = self.GetStart(), self.GetEnd()
        self._set_point(0, (s.x + d.x, s.y + d.y))
        self._set_point(1, (e.x + d.x, e.y + d.y))

    def SetLayer(self, layer):
        _set_kid(self._node, "layer", _layer_name(layer))
        t = _kid(self._node, "gr_text")
        if t is not None:
            _set_kid(t, "layer", _layer_name(layer))
        self._touch()

    # ---- height and orientation
    def _num(self, name, default=0.0, block=None):
        k = _kid(_kid(self._node, block) if block else self._node, name)
        return _f(k[1]) if k is not None and len(k) > 1 else default

    def _put(self, name, value, block=None):
        host = self._node
        if block:
            host = _kid(self._node, block)
            if host is None:
                host = _set_kid(self._node, block)
        _set_kid(host, name, value)
        self._update()

    def _flag(self, name, on, block):
        host = _kid(self._node, block)
        if host is None:
            host = _set_kid(self._node, block)
        host[:] = [c for c in host if not (isinstance(c, Sym) and str(c) == name) and not (isinstance(c, list) and c and c[0] == name)]
        if on:
            host.append([Sym(name), Sym("yes")] if self._board is not None and getattr(self._board, "_version", 0) >= 20240108 else Sym(name))
        self._update()

    def _has(self, name, block):
        host = _kid(self._node, block) or []
        for c in host:
            if isinstance(c, Sym) and str(c) == name:
                return True
            if isinstance(c, list) and c and c[0] == name:
                return len(c) < 2 or str(c[1]) != "no"
        return False

    def GetHeight(self):
        return FromMM(self._num("height"))

    def SetHeight(self, v):
        self._put("height", ToMM(v))

    def GetOrientation(self):
        return int(self._num("orientation"))

    def SetOrientation(self, v):
        self._put("orientation", int(v))

    def GetAngle(self):
        s, e = self.GetStart(), self.GetEnd()
        return _math.degrees(_math.atan2(e.y - s.y, e.x - s.x))

    def _crossbar(self, i):
        """Where the dimension line's ends are: the measured points moved out by the height."""
        s, e = self.GetStart(), self.GetEnd()
        h = self.GetHeight()
        k = _kid(self._node, "type")
        if (str(k[1]) if k is not None and len(k) > 1 else self._KIND) == "orthogonal":
            if self.GetOrientation() == self.DIR_HORIZONTAL:
                y = s.y + h
                return VECTOR2I(s.x if i == 0 else e.x, y)
            x = s.x + h
            return VECTOR2I(x, s.y if i == 0 else e.y)
        d = _math.hypot(e.x - s.x, e.y - s.y) or 1.0
        nx, ny = -(e.y - s.y) / d, (e.x - s.x) / d
        p = s if i == 0 else e
        return VECTOR2I(int(p.x + nx * h), int(p.y + ny * h))

    def GetCrossbarStart(self):
        return self._crossbar(0)

    def GetCrossbarEnd(self):
        return self._crossbar(1)

    def GetMeasuredValue(self):
        a, b = self._crossbar(0), self._crossbar(1)
        return int(round(_math.hypot(b.x - a.x, b.y - a.y)))

    # ---- format
    def GetUnitsMode(self):
        return int(self._num("units", 3, "format"))

    def SetUnitsMode(self, mode):
        self._put("units", int(mode), "format")

    def GetUnits(self):
        return {DIM_UNITS_MODE_INCHES: EDA_UNITS_INCHES, DIM_UNITS_MODE_MILS: EDA_UNITS_MILS}.get(self.GetUnitsMode(), EDA_UNITS_MILLIMETRES)

    def SetUnits(self, units):
        self.SetUnitsMode({EDA_UNITS_INCHES: DIM_UNITS_MODE_INCHES, EDA_UNITS_MILS: DIM_UNITS_MODE_MILS}.get(units, DIM_UNITS_MODE_MILLIMETRES))

    def GetUnitsFormat(self):
        return int(self._num("units_format", 1, "format"))

    def SetUnitsFormat(self, v):
        self._put("units_format", int(v), "format")

    def GetPrecision(self):
        return int(self._num("precision", 4, "format"))

    def SetPrecision(self, v):
        self._put("precision", int(v), "format")

    def GetSuppressZeroes(self):
        return self._has("suppress_zeroes", "format")

    def SetSuppressZeroes(self, on=True):
        self._flag("suppress_zeroes", on, "format")

    def _affix(self, name):
        k = _kid(_kid(self._node, "format") or [], name)
        return str(k[1]) if k is not None and len(k) > 1 else ""

    def GetPrefix(self):
        return self._affix("prefix")

    def SetPrefix(self, text):
        self._put("prefix", str(text), "format")

    def GetSuffix(self):
        return self._affix("suffix")

    def SetSuffix(self, text):
        self._put("suffix", str(text), "format")

    def GetOverrideTextEnabled(self):
        return _kid(_kid(self._node, "format") or [], "override_value") is not None

    def GetOverrideText(self):
        return self._affix("override_value")

    def SetOverrideText(self, text):
        self._put("override_value", str(text), "format")

    def SetOverrideTextEnabled(self, on=True):
        if not on:
            f = _kid(self._node, "format")
            if f is not None:
                _drop_kid(f, "override_value")
            self._update()

    # ---- style
    def GetLineThickness(self):
        return FromMM(self._num("thickness", 0.1, "style"))

    def SetLineThickness(self, v):
        self._put("thickness", ToMM(v), "style")

    def GetArrowLength(self):
        return FromMM(self._num("arrow_length", 1.27, "style"))

    def SetArrowLength(self, v):
        self._put("arrow_length", ToMM(v), "style")

    def GetExtensionOffset(self):
        return FromMM(self._num("extension_offset", 0.5, "style"))

    def SetExtensionOffset(self, v):
        self._put("extension_offset", ToMM(v), "style")

    def GetExtensionHeight(self):
        return FromMM(self._num("extension_height", 0.58642, "style"))

    def SetExtensionHeight(self, v):
        self._put("extension_height", ToMM(v), "style")

    def GetTextPositionMode(self):
        return int(self._num("text_position_mode", 0, "style"))

    def SetTextPositionMode(self, v):
        self._put("text_position_mode", int(v), "style")

    def GetKeepTextAligned(self):
        return self._has("keep_text_aligned", "style")

    def SetKeepTextAligned(self, on=True):
        self._flag("keep_text_aligned", on, "style")

    # ---- the text
    def GetValueText(self):
        if self.GetOverrideTextEnabled():
            return self.GetOverrideText()
        mode = self.GetUnitsMode()
        mm = ToMM(self.GetMeasuredValue())
        v, unit = {DIM_UNITS_MODE_INCHES: (mm / 25.4, "in"), DIM_UNITS_MODE_MILS: (mm / 0.0254, "mils")}.get(mode, (mm, "mm"))
        t = "%.*f" % (max(0, min(self.GetPrecision(), 9)), v)
        if self.GetSuppressZeroes() and "." in t:
            t = t.rstrip("0").rstrip(".")
        fmt = self.GetUnitsFormat()
        if fmt == 1:
            t += " " + unit
        elif fmt == 2:
            t += " (" + unit + ")"
        return self.GetPrefix() + t + self.GetSuffix()

    def GetText(self):
        t = _kid(self._node, "gr_text")
        return str(t[1]) if t is not None and len(t) > 1 else ""

    def _text_size(self):
        t = _kid(self._node, "gr_text")
        f = _kid(_kid(t, "effects") or [], "font") if t is not None else None
        k = _kid(f, "size") if f is not None else None
        return _f(k[1]) if k is not None and len(k) > 1 else 1.0

    def Update(self):
        self._update()

    def _update(self):
        """Refresh the shown value and, unless it was placed by hand, where it sits: centred just outside the dimension line."""
        t = _kid(self._node, "gr_text")
        if t is not None and len(t) > 1:
            t[1] = self.GetValueText()
            if self.GetTextPositionMode() != 3:
                a, b = self._crossbar(0), self._crossbar(1)
                d = _math.hypot(b.x - a.x, b.y - a.y) or 1.0
                ux, uy = (b.x - a.x) / d, (b.y - a.y) / d
                nx, ny = uy, -ux
                h = self.GetHeight()
                s, e = self.GetStart(), self.GetEnd()
                side = (a.x - s.x) * nx + (a.y - s.y) * ny
                sign = -1.0 if side < 0 or (side == 0 and h < 0) else 1.0
                off = 0.0 if self.GetTextPositionMode() == 1 else FromMM(self._text_size() / 2 + 0.15 + self._num("thickness", 0.1, "style")) * sign
                x, y = (a.x + b.x) / 2 + nx * off, (a.y + b.y) / 2 + ny * off
                ang = -_math.degrees(_math.atan2(uy, ux)) if self.GetKeepTextAligned() else 0.0
                while ang > 90:
                    ang -= 180
                while ang <= -90:
                    ang += 180
                at = [Sym("at"), _n(ToMM(x)), _n(ToMM(y))] + ([_n(ang)] if abs(ang) > 1e-9 else [])
                old = _kid(t, "at")
                if old is None:
                    t.insert(2, at)
                else:
                    old[:] = at
        self._touch()


class PCB_DIM_ALIGNED(PCB_DIMENSION_BASE):
    _TYPE, _CLASS, _KIND = PCB_DIM_ALIGNED_T, "PCB_DIM_ALIGNED", "aligned"


class PCB_DIM_ORTHOGONAL(PCB_DIM_ALIGNED):
    _TYPE, _CLASS, _KIND = PCB_DIM_ORTHOGONAL_T, "PCB_DIM_ORTHOGONAL", "orthogonal"


class PCB_DIM_LEADER(PCB_DIMENSION_BASE):
    _TYPE, _CLASS, _KIND = PCB_DIM_LEADER_T, "PCB_DIM_LEADER", "leader"


class PCB_DIM_CENTER(PCB_DIMENSION_BASE):
    _TYPE, _CLASS, _KIND = PCB_DIM_CENTER_T, "PCB_DIM_CENTER", "center"


class PCB_DIM_RADIAL(PCB_DIMENSION_BASE):
    _TYPE, _CLASS, _KIND = PCB_DIM_RADIAL_T, "PCB_DIM_RADIAL", "radial"


DIMENSION = PCB_DIMENSION_BASE


class _OtherItem(BOARD_ITEM):
    """Something on the board this module has no class for: it is kept, and can be moved by its `at`."""
    _CLASS = "BOARD_ITEM"


class PCB_REFERENCE_IMAGE(_OtherItem):
    _TYPE, _CLASS, _TOKEN = PCB_REFERENCE_IMAGE_T, "PCB_REFERENCE_IMAGE", "image"


class PCB_TARGET(_OtherItem):
    _TYPE, _CLASS, _TOKEN = PCB_TARGET_T, "PCB_TARGET", "target"


class PCB_MARKER(_OtherItem):
    _TYPE, _CLASS = PCB_MARKER_T, "PCB_MARKER"


class PCB_GENERATOR(_OtherItem):
    _TYPE, _CLASS, _TOKEN = PCB_GENERATOR_T, "PCB_GENERATOR", "generated"


class PCB_TABLE(_OtherItem):
    _TYPE, _CLASS, _TOKEN = PCB_TABLE_T, "PCB_TABLE", "table"


class PCB_BARCODE(_OtherItem):
    _TYPE, _CLASS, _TOKEN = PCB_BARCODE_T, "PCB_BARCODE", "barcode"


# ----------------------------------------------------------------------------- nets and settings

class NETINFO_ITEM:
    def __init__(self, board=None, name="", code=-1):
        self._board, self._name, self._code = board, str(name), code
        if board is not None and isinstance(board, BOARD) and code == -1:
            self._code = board._net_code(self._name, create=True)

    def GetNetname(self):
        return self._name

    GetDisplayNetname = GetNetname

    def GetShortNetname(self):
        return self._name.rsplit("/", 1)[-1]

    def GetNetCode(self):
        return self._code

    GetNet = GetNetCode
    GetNetcode = GetNetCode

    def GetNetClassName(self):
        return _netclass_name(self.GetNetname())

    GetClassName = GetNetClassName

    def GetNetClass(self):
        return _netclasses()[_netclass_name(self.GetNetname())]

    GetNetClassSlow = GetNetClass

    def SetNetname(self, name):
        self._name = str(name)

    def IsCurrent(self):
        return True

    def GetBoard(self):
        return self._board

    def __repr__(self):
        return f"<NETINFO_ITEM {self._code} {self._name!r}>"

    def __eq__(self, o):
        return isinstance(o, NETINFO_ITEM) and o._name == self._name

    def __hash__(self):
        return hash(self._name)


class NETINFO_LIST:
    def __init__(self, board):
        self._board = board

    def NetsByName(self):
        return self._board.GetNetsByName()

    def NetsByNetcode(self):
        return self._board.GetNetsByNetcode()

    def GetNetCount(self):
        return len(self._board._net_names)

    def GetNetItem(self, key):
        return self._board.FindNet(key)

    def __iter__(self):
        return iter(self._board.GetNetsByNetcode().values())

    def __len__(self):
        return self.GetNetCount()


def _project():
    p = getattr(_Host, "project", None)
    return p if isinstance(p, dict) else {}


def _net_settings():
    ns = _project().get("net_settings")
    return ns if isinstance(ns, dict) else {}


class _NoSuchKey(KeyError, IndexError):
    pass


class _NetClassMap(dict):
    """Net classes by name, as KiCad hands them out: a mapping (KiCad 7 and later), which also answers the calls of the
    NETCLASSES object of KiCad 5 and 6 (NetClasses(), Find(), GetDefault(), GetCount()) that older plugins still make."""

    def NetClasses(self):
        return self

    def __missing__(self, name):
        # KiCad's map answers a name it does not hold with IndexError ("key not found"); plugins catch either
        raise _NoSuchKey(name)

    def Find(self, name):
        return _netclasses().get(str(name))

    def GetDefault(self):
        return _netclasses()["Default"]

    GetDefaultPtr = GetDefault

    def GetCount(self):
        return len(self)

    def asdict(self):
        return dict(self)


def _netclasses():
    """The project's net classes by name, Default first (the .kicad_pro file's net_settings)."""
    ns = _net_settings()
    cache = getattr(_Host, "_nc_cache", None)
    if cache is not None and cache[0] is ns:
        return cache[1]
    out = {"Default": NETCLASS("Default")}
    for c in ns.get("classes") or []:
        if isinstance(c, dict) and c.get("name"):
            nc = NETCLASS(str(c["name"]))
            for key, mine in (("clearance", "clearance"), ("track_width", "track"), ("via_diameter", "via"), ("via_drill", "drill"),
                              ("microvia_diameter", "uvia"), ("microvia_drill", "uvia_drill"), ("diff_pair_width", "dp_width"), ("diff_pair_gap", "dp_gap")):
                if isinstance(c.get(key), (int, float)):
                    nc._v[mine] = float(c[key])
            out[nc._name] = nc
    _Host._nc_cache = (ns, out)
    return out


def _netclass_name(netname):
    """Which class a net belongs to: a direct assignment, then the first matching pattern, else Default."""
    ns = _net_settings()
    classes = _netclasses()
    a = (ns.get("netclass_assignments") or {}).get(netname)
    a = a[0] if isinstance(a, list) and a else a
    if isinstance(a, str) and a in classes:
        return a
    for pat in ns.get("netclass_patterns") or []:
        if isinstance(pat, dict) and pat.get("netclass") in classes and pat.get("pattern"):
            import fnmatch as _fn
            if _fn.fnmatchcase(str(netname), str(pat["pattern"])):
                return str(pat["netclass"])
    return "Default"


def _rule(name, default):
    """A design rule in mm from the project file (board.design_settings.rules)."""
    r = ((_project().get("board") or {}).get("design_settings") or {}).get("rules") or {}
    v = r.get(name)
    return float(v) if isinstance(v, (int, float)) else default


class NETCLASS:
    def __init__(self, name="Default"):
        self._name = name
        self._v = {"clearance": 0.2, "track": 0.2, "via": 0.6, "drill": 0.3, "uvia": 0.3, "uvia_drill": 0.1, "dp_width": 0.2, "dp_gap": 0.25}

    def GetName(self):
        return self._name

    def GetClearance(self, *_):
        return FromMM(self._v["clearance"])

    def GetTrackWidth(self):
        return FromMM(self._v["track"])

    def GetViaDiameter(self):
        return FromMM(self._v["via"])

    def GetViaDrill(self):
        return FromMM(self._v["drill"])

    def GetuViaDiameter(self):
        return FromMM(self._v["uvia"])

    def GetuViaDrill(self):
        return FromMM(self._v["uvia_drill"])

    def GetDiffPairWidth(self):
        return FromMM(self._v["dp_width"])

    def GetDiffPairGap(self):
        return FromMM(self._v["dp_gap"])

    def GetDescription(self):
        return ""

    def HasClearance(self):
        return True

    def HasTrackWidth(self):
        return True

    def HasViaDiameter(self):
        return True

    def HasViaDrill(self):
        return True


class TITLE_BLOCK:
    def __init__(self, node=None):
        self._node = node if node is not None else [Sym("title_block")]

    def _get(self, name):
        k = _kid(self._node, name)
        return str(k[1]) if k is not None and len(k) > 1 else ""

    def GetTitle(self):
        return self._get("title")

    def GetDate(self):
        return self._get("date")

    def GetRevision(self):
        return self._get("rev")

    def GetCompany(self):
        return self._get("company")

    def GetComment(self, i):
        for c in _kids(self._node, "comment"):
            if len(c) > 2 and int(_f(c[1])) == int(i) + 1:
                return str(c[2])
        return ""

    def _ro(self, *_):
        _unsupported("Changing the title block from a plugin")

    SetTitle = SetDate = SetRevision = SetCompany = SetComment = _ro


class BOARD_STACKUP:
    def __init__(self, board):
        self._board = board

    def GetCount(self):
        return len(self.GetList())

    def GetList(self):
        return []

    def BuildBoardThicknessFromStackup(self):
        return self._board.GetDesignSettings().GetBoardThickness()

    def GetStackupLayer(self, i):
        return None

    def FormatBoardStackup(self, *_):
        pass


class BOARD_DESIGN_SETTINGS:
    """The board's design settings, as far as the board file carries them.  Read-only on the web."""

    def __init__(self, board):
        self._board = board
        s = board._setup
        self.m_TrackMinWidth = FromMM(_rule("min_track_width", 0.2))
        self.m_ViasMinSize = FromMM(_rule("min_via_diameter", 0.4))
        self.m_MinThroughDrill = FromMM(_rule("min_through_hole_diameter", 0.3))
        self.m_ViasMinAnnularWidth = FromMM(_rule("min_via_annular_width", 0.05))
        self.m_MinClearance = FromMM(_rule("min_clearance", 0.0))
        self.m_CopperEdgeClearance = FromMM(_rule("min_copper_edge_clearance", 0.5))
        self.m_HoleClearance = FromMM(_rule("min_hole_clearance", 0.25))
        self.m_HoleToHoleMin = FromMM(_rule("min_hole_to_hole", 0.25))
        self.m_MicroViasMinSize = FromMM(_rule("min_microvia_diameter", 0.2))
        self.m_MicroViasMinDrill = FromMM(_rule("min_microvia_drill", 0.1))
        self.m_SolderMaskExpansion = FromMM(_f((_kid(s, "pad_to_mask_clearance") or [0, 0])[1])) if s is not None else 0
        self.m_SolderMaskMinWidth = FromMM(_f((_kid(s, "solder_mask_min_width") or [0, 0])[1])) if s is not None else 0
        self.m_SolderPasteMargin = FromMM(_f((_kid(s, "pad_to_paste_clearance") or [0, 0])[1])) if s is not None else 0
        self.m_SolderPasteMarginRatio = _f((_kid(s, "pad_to_paste_clearance_ratio") or [0, 0])[1]) if s is not None else 0.0
        ds = (_project().get("board") or {}).get("design_settings") or {}
        widths = [FromMM(w) for w in ds.get("track_widths") or [] if isinstance(w, (int, float)) and w > 0]
        self.m_TrackWidthList = [FromMM(_netclasses()["Default"]._v["track"])] + widths
        self.m_ViasDimensionsList = []
        self.m_DiffPairDimensionsList = []
        self.m_NetSettings = self
        self.m_DefaultNetClass = _netclasses()["Default"]
        self.m_HasStackup = s is not None and _kid(s, "stackup") is not None
        self.m_TextSize = [VECTOR2I(FromMM(1), FromMM(1))] * LAYER_CLASS_COUNT
        self.m_TextThickness = [FromMM(0.15)] * LAYER_CLASS_COUNT
        self.m_LineThickness = [FromMM(0.1)] * LAYER_CLASS_COUNT

    def CloneFrom(self, other):
        """Take another board's settings (the setup block of its file: stack-up, mask and paste margins, plot settings)."""
        src = getattr(getattr(other, "_board", None), "_setup", None)
        if src is not None:
            self._board._section("setup")[:] = _copy.deepcopy(src)
        self.__init__(self._board)

    def _origin(self, name):
        s = self._board._setup
        k = _kid(s, name) if s is not None else None
        return VECTOR2I(FromMM(_f(k[1])), FromMM(_f(k[2]))) if k is not None and len(k) > 2 else VECTOR2I(0, 0)

    def GetAuxOrigin(self):
        return self._origin("aux_axis_origin")

    def GetGridOrigin(self):
        return self._origin("grid_origin")

    def _set_origin(self, name, a):
        p = VECTOR2I(*a)
        _set_kid(self._board._section("setup"), name, ToMM(p.x), ToMM(p.y))

    def SetAuxOrigin(self, *a):
        self._set_origin("aux_axis_origin", a)

    def SetGridOrigin(self, *a):
        self._set_origin("grid_origin", a)

    def SetBoardThickness(self, v):
        _set_kid(self._board._section("general"), "thickness", ToMM(v))

    def GetBoardThickness(self):
        g = self._board._general
        k = _kid(g, "thickness") if g is not None else None
        return FromMM(_f(k[1])) if k is not None and len(k) > 1 else FromMM(1.6)

    def GetCopperLayerCount(self):
        return len(self._board._copper_layers())

    def GetEnabledLayers(self):
        return self._board.GetEnabledLayers()

    def IsLayerEnabled(self, layer):
        return self._board.IsLayerEnabled(layer)

    # The sizes new tracks and vias get: entry 0 of each list is "the net class's size", the others are the board's
    # predefined sizes (Board Setup → Pre-defined Sizes).
    def _vias(self):
        nc = _netclasses()["Default"]._v
        ds = (_project().get("board") or {}).get("design_settings") or {}
        out = [(FromMM(nc.get("via", 0.6)), FromMM(nc.get("drill", 0.3)))]
        for v in ds.get("via_dimensions") or []:
            if isinstance(v, dict) and (v.get("diameter") or 0) > 0:
                out.append((FromMM(v["diameter"]), FromMM(v.get("drill") or 0)))
        return out

    # the colour a net is drawn in (Appearance → Nets); the editor keeps these, see the Appearance panel of its frame
    def SetNetColorAssignment(self, netname, color):
        colors = self._board.__dict__.setdefault("_net_colors", {})
        if color is None or color == COLOR4D.UNSPECIFIED:
            colors.pop(str(netname), None)
        else:
            colors[str(netname)] = COLOR4D(color)

    def GetNetColorAssignments(self):
        return dict(self._board.__dict__.get("_net_colors", {}))

    HasNetColorAssignment = lambda self, netname: str(netname) in self._board.__dict__.get("_net_colors", {})

    # m_NetSettings is this object: the net class a net gets (its assignment or pattern, else Default)
    def GetEffectiveNetClass(self, netname):
        return _netclasses()[_netclass_name(str(netname))]

    GetNetClassByName = lambda self, name: _netclasses().get(str(name), _netclasses()["Default"])
    GetDefaultNetclass = lambda self: _netclasses()["Default"]

    def GetTrackWidthIndex(self):
        return min(self.__dict__.get("_track_index", 0), len(self.m_TrackWidthList) - 1)

    def SetTrackWidthIndex(self, index):
        self.__dict__["_track_index"] = max(0, min(int(index), len(self.m_TrackWidthList) - 1))

    def GetViaSizeIndex(self):
        return min(self.__dict__.get("_via_index", 0), len(self._vias()) - 1)

    def SetViaSizeIndex(self, index):
        self.__dict__["_via_index"] = max(0, min(int(index), len(self._vias()) - 1))

    def GetCurrentTrackWidth(self):
        return self.m_TrackWidthList[self.GetTrackWidthIndex()]

    def GetCurrentViaSize(self):
        return self._vias()[self.GetViaSizeIndex()][0]

    def GetCurrentViaDrill(self):
        return self._vias()[self.GetViaSizeIndex()][1]

    def GetCurrentNetClassName(self):
        return "Default"

    def GetDefault(self):
        return self.m_DefaultNetClass

    GetDefaultNetclass = GetDefault

    def GetNetClasses(self):
        return _NetClassMap((k, v) for k, v in _netclasses().items() if k != "Default")

    GetNetclasses = GetNetClasses

    def GetSmallestClearanceValue(self):
        return FromMM(0.2)

    GetBiggestClearanceValue = GetSmallestClearanceValue

    def GetStackupDescriptor(self):
        return BOARD_STACKUP(self._board)

    def GetLineThickness(self, layer):
        return FromMM(0.12 if not IsCopperLayer(layer) else 0.2)

    def GetTextSize(self, layer):
        return VECTOR2I(FromMM(1), FromMM(1))

    def GetTextThickness(self, layer):
        return FromMM(0.15)

    def GetLayerClass(self, layer):
        return LAYER_CLASS_COPPER if IsCopperLayer(layer) else LAYER_CLASS_OTHERS

    def GetSeverity(self, *_):
        return RPT_SEVERITY_ERROR

    def GetCustomTrackWidth(self):
        return FromMM(0.25)

    def GetCustomViaSize(self):
        return FromMM(0.6)

    def GetCustomViaDrill(self):
        return FromMM(0.3)

    def UseCustomTrackViaSize(self, *_):
        return False


class TEXT_ATTRIBUTES:
    def __init__(self, *_):
        self.m_Halign = GR_TEXT_H_ALIGN_CENTER
        self.m_Valign = GR_TEXT_V_ALIGN_CENTER
        self.m_Angle = EDA_ANGLE(0)
        self.m_Italic = self.m_Bold = self.m_Mirrored = self.m_Multiline = False
        self.m_Visible = self.m_KeepUpright = True
        self.m_Size = VECTOR2I(FromMM(1), FromMM(1))
        self.m_StrokeWidth = FromMM(0.15)


class COLOR4D:
    def __init__(self, r=0.0, g=0.0, b=0.0, a=1.0):
        if isinstance(r, str):              # "#RRGGBB", "#RRGGBBAA", "rgb(r, g, b)", "rgba(r, g, b, a)"
            text = r.strip()
            r, g, b, a = 0.0, 0.0, 0.0, 1.0
            if text.startswith("#") and len(text) in (7, 9):
                r, g, b = (int(text[i:i + 2], 16) / 255.0 for i in (1, 3, 5))
                if len(text) == 9:
                    a = int(text[7:9], 16) / 255.0
            else:
                nums = _re.findall(r"[0-9.]+", text)
                if len(nums) >= 3:
                    r, g, b = (float(n) / 255.0 for n in nums[:3])
                    a = float(nums[3]) if len(nums) > 3 else 1.0
        elif isinstance(r, COLOR4D):
            r, g, b, a = r.r, r.g, r.b, r.a
        self.r, self.g, self.b, self.a = r, g, b, a

    def __eq__(self, other):
        return isinstance(other, COLOR4D) and (self.r, self.g, self.b, self.a) == (other.r, other.g, other.b, other.a)

    def __hash__(self):
        return hash((self.r, self.g, self.b, self.a))

    def ToCSSString(self):
        r, g, b = (int(round(max(0.0, min(1.0, v)) * 255)) for v in (self.r, self.g, self.b))
        return "rgb(%d, %d, %d)" % (r, g, b) if self.a >= 1.0 else "rgba(%d, %d, %d, %.3f)" % (r, g, b, self.a)

    def ToHexString(self):
        r, g, b, a = (int(round(max(0.0, min(1.0, v)) * 255)) for v in (self.r, self.g, self.b, self.a))
        return "#%02X%02X%02X%02X" % (r, g, b, a)

    def WithAlpha(self, alpha):
        return COLOR4D(self.r, self.g, self.b, alpha)

    def Brightened(self, factor):
        return COLOR4D(*(v + (1.0 - v) * factor for v in (self.r, self.g, self.b)), self.a)

    def Darkened(self, factor):
        return COLOR4D(*(v * (1.0 - factor) for v in (self.r, self.g, self.b)), self.a)


COLOR4D.UNSPECIFIED = COLOR4D(0.0, 0.0, 0.0, 0.0)
COLOR4D.WHITE = COLOR4D(1.0, 1.0, 1.0, 1.0)
COLOR4D.BLACK = COLOR4D(0.0, 0.0, 0.0, 1.0)
COLOR4D.CLEAR = COLOR4D(1.0, 0.0, 1.0, 0.0)


class CONNECTIVITY_DATA:
    """Connectivity as the board file states it: items that share a net."""

    def __init__(self, board):
        self._board = board

    def GetNetItems(self, net, types=None):
        b = self._board
        name = b._net_names.get(int(net), "") if isinstance(net, int) else net.GetNetname()
        out = []
        for it in list(b.GetTracks()) + list(b.GetPads()) + list(b.Zones()):
            if it.GetNetname() == name and (not types or it.Type() in types):
                out.append(it)
        return out

    def GetConnectedItems(self, item, types=None, *_):
        return [it for it in self.GetNetItems(item.GetNet(), types if isinstance(types, (list, tuple)) else None) if it is not item and it != item]

    def GetConnectedPads(self, item):
        return [p for p in self._board.GetPads() if p.GetNetname() == item.GetNetname()]

    def GetConnectedTracks(self, item):
        return [t for t in self._board.GetTracks() if t.GetNetname() == item.GetNetname() and t != item]

    def GetNetCount(self):
        return len(self._board._net_names)

    def GetUnconnectedCount(self, *_):
        return 0

    def GetPadCount(self, net=-1):
        pads = self._board.GetPads()
        return len(pads) if net < 0 else len([p for p in pads if p.GetNetCode() == net])

    def GetNodeCount(self, net=-1):
        return self.GetPadCount(net)

    def IsConnectedOnLayer(self, *_):
        return True

    def _touches(self, track, point):
        """Does copper of the same net, other than `track`, reach this point on one of the track's layers?"""
        b = self._board
        layers = set(track.GetLayerSet().Seq()) if hasattr(track, "GetLayerSet") else {track.GetLayer()}
        net = track.GetNetCode()
        px, py = point.x, point.y
        for other in b.GetTracks():
            if other is track or other == track or other.GetNetCode() != net:
                continue
            if isinstance(other, PCB_VIA):
                if not (layers & set(other.GetLayerSet().Seq())):
                    continue
                c = other.GetPosition()
                if _math.hypot(px - c.x, py - c.y) <= other.GetWidth() / 2 + 1:
                    return True
                continue
            if other.GetLayer() not in layers:
                continue
            reach = other.GetWidth() / 2 + 1
            if isinstance(other, PCB_ARC):
                # an arc joins at its two ends
                ends = (other.GetStart(), other.GetEnd())
                if any(_math.hypot(px - e.x, py - e.y) <= reach for e in ends):
                    return True
                continue
            a, e = other.GetStart(), other.GetEnd()
            dx, dy = e.x - a.x, e.y - a.y
            ln = dx * dx + dy * dy
            t = 0.0 if not ln else max(0.0, min(1.0, ((px - a.x) * dx + (py - a.y) * dy) / ln))
            if _math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)) <= reach:
                return True
        for pad in b.GetPads():
            if pad.GetNetCode() != net:
                continue
            try:
                on = layers & set(pad.GetLayerSet().Seq())
            except Exception:
                on = layers
            if on and pad.HitTest(VECTOR2I(px, py)):
                return True
        return False

    def TestTrackEndpointDangling(self, track, ignoreTracksInPads=True, pos=None):
        """True when an end of the track (a via: the via) joins nothing of its net.  With `pos` given, the dangling
        end's position is written into it, as KiCad does."""
        if isinstance(track, PCB_VIA):
            dangling = not self._touches(track, track.GetPosition())
            if dangling and pos is not None and hasattr(pos, "x"):
                pos.x, pos.y = track.GetPosition().x, track.GetPosition().y
            return dangling
        for end in (track.GetStart(), track.GetEnd()):
            if not self._touches(track, end):
                if pos is not None and hasattr(pos, "x"):
                    pos.x, pos.y = end.x, end.y
                return True
        return False

    def RecalculateRatsnest(self, *_):
        pass

    def Build(self, *_):
        pass

    def Update(self, *_):
        pass

    def PropagateNets(self, *_):
        pass

    def ClearRatsnest(self):
        pass

    def HideLocalRatsnest(self):
        pass

    def GetLocalRatsnest(self):
        return []


# ----------------------------------------------------------------------------- the board

_ITEM_CLASSES = {
    "footprint": FOOTPRINT, "module": FOOTPRINT, "segment": PCB_TRACK, "arc": PCB_ARC, "via": PCB_VIA, "zone": ZONE,
    "gr_line": PCB_SHAPE, "gr_rect": PCB_SHAPE, "gr_circle": PCB_SHAPE, "gr_arc": PCB_SHAPE, "gr_poly": PCB_SHAPE,
    "gr_curve": PCB_SHAPE, "gr_text": PCB_TEXT, "gr_text_box": PCB_TEXTBOX, "group": PCB_GROUP, "dimension": PCB_DIMENSION_BASE,
    "image": PCB_REFERENCE_IMAGE, "target": PCB_TARGET, "generated": PCB_GENERATOR, "table": PCB_TABLE, "barcode": PCB_BARCODE,
}
_HEAD = ("version", "generator", "generator_version", "general", "paper", "page", "title_block", "layers", "setup", "net",
         "net_class", "property", "embedded_fonts", "embedded_files")


class BOARD(EDA_ITEM):
    _TYPE, _CLASS = PCB_T, "BOARD"

    def __init__(self, text=None, filename=""):
        self._filename = filename
        self._items = []            # top-level BOARD_ITEMs, in file order
        self._by_id = {}
        self._original = {}         # uuid -> the item as it arrived, for the commit
        self._removed = []
        self._net_names = {0: ""}
        self._net_codes = {"": 0}
        self._nets_by_name_only = True
        self._layers = []           # (id, name, type, user name)
        self._setup = self._general = self._title = None
        self._version = 0
        self._modified = False
        self._selection_changed = False
        self._props = {}
        self._wants_refill = False
        if text:
            self._load(text)

    def _load(self, text):
        trees = _parse(text)
        root = next((t for t in trees if isinstance(t, list) and t and t[0] == "kicad_pcb"), None)
        if root is None:
            raise ValueError("this is not a KiCad board")
        self._head = [n for n in root[1:] if isinstance(n, list) and n and (n[0] in _HEAD or (n[0] not in _ITEM_CLASSES and _kid(n, "uuid") is None))]
        for n in root[1:]:
            if not isinstance(n, list) or not n:
                continue
            t = n[0]
            if t == "version" and len(n) > 1:
                self._version = int(_f(n[1]))
            elif t == "general":
                self._general = n
            elif t == "setup":
                self._setup = n
            elif t == "title_block":
                self._title = n
            elif t == "layers":
                for l in n[1:]:
                    if isinstance(l, list) and len(l) >= 3:
                        self._layers.append((int(_f(l[0])), str(l[1]), str(l[2]), str(l[3]) if len(l) > 3 and not isinstance(l[3], list) else ""))
            elif t == "net" and len(n) > 2:
                self._nets_by_name_only = False
                code, name = int(_f(n[1])), str(n[2])
                self._net_names[code] = name
                self._net_codes[name] = code
            elif t == "property" and len(n) > 2:
                self._props[str(n[1])] = str(n[2])
            elif t in _ITEM_CLASSES or (t not in _HEAD and _kid(n, "uuid") is not None):
                it = _ITEM_CLASSES.get(t, _OtherItem)._wrap(n, self)
                self._items.append(it)
                uid = it.m_Uuid.AsString()
                self._by_id[uid] = it
                self._original[uid] = it
        if self._nets_by_name_only:
            names = set()
            for it in self._items:
                if isinstance(it, FOOTPRINT):
                    for p in it.Pads():
                        names.add(p._net_name())
                elif isinstance(it, BOARD_CONNECTED_ITEM):
                    names.add(it._net_name())
            for name in sorted(n for n in names if n):
                self._net_code(name, create=True)

    # -- nets
    def _net_code(self, name, create=False):
        c = self._net_codes.get(name)
        if c is None:
            if not create:
                return 0
            c = max(self._net_names) + 1 if self._net_names else 1
            self._net_codes[name] = c
            self._net_names[c] = name
        return c

    def _net_item(self, name):
        return NETINFO_ITEM(None, name, self._net_code(name))

    def GetNetsByName(self):
        return {name: NETINFO_ITEM(None, name, code) for name, code in self._net_codes.items()}

    def GetNetsByNetcode(self):
        return {code: NETINFO_ITEM(None, name, code) for code, name in self._net_names.items()}

    def GetNetInfo(self):
        return NETINFO_LIST(self)

    def GetNetCount(self):
        return len(self._net_names)

    def FindNet(self, key):
        if isinstance(key, int):
            return NETINFO_ITEM(None, self._net_names[key], key) if key in self._net_names else None
        key = str(key)
        return NETINFO_ITEM(None, key, self._net_codes[key]) if key in self._net_codes else None

    def GetNetcodeFromNetname(self, name):
        return self._net_codes.get(str(name), -1)

    def GetNetCodeFromNetname(self, name):
        return self._net_codes.get(str(name), -1)

    def GetConnectivity(self):
        return CONNECTIVITY_DATA(self)

    def BuildConnectivity(self, *_):
        return True

    def BuildListOfNets(self):
        pass

    def SynchronizeNetsAndNetClasses(self, *_):
        pass

    def GetAllNetClasses(self):
        return _NetClassMap(_netclasses())

    def GetNetClasses(self):
        return _NetClassMap((k, v) for k, v in _netclasses().items() if k != "Default")

    # -- items
    def _of(self, *classes):
        return [it for it in self._items if isinstance(it, classes)]

    def GetFootprints(self):
        return self._of(FOOTPRINT)

    Footprints = GetFootprints
    GetModules = GetFootprints
    Modules = GetFootprints

    def GetTracks(self):
        return self._of(PCB_TRACK)

    Tracks = GetTracks

    def GetDrawings(self):
        return [it for it in self._items if isinstance(it, (PCB_SHAPE, PCB_TEXT, PCB_DIMENSION_BASE, _OtherItem)) and not isinstance(it, PCB_GROUP)]

    Drawings = GetDrawings

    def Zones(self):
        return self._of(ZONE)

    def GetAreaCount(self):
        return len(self.Zones())

    def GetArea(self, i):
        return self.Zones()[i]

    def Groups(self):
        return self._of(PCB_GROUP)

    def Markers(self):
        return []

    def Generators(self):
        return self._of(PCB_GENERATOR)

    def GetPads(self):
        return [p for f in self.GetFootprints() for p in f.Pads()]

    def GetSortedPadListByXthenYCoord(self, into, net_code=-1):
        """Fill the list given with the board's pads (or one net's), from left to right and, in a column, top down."""
        pads = [p for p in self.GetPads() if net_code < 0 or p.GetNetCode() == net_code]
        pads.sort(key=lambda p: (p.GetPosition().x, p.GetPosition().y))
        into[:] = pads

    def AllConnectedItems(self):
        return list(self.GetTracks()) + self.GetPads() + self.Zones()

    def GetItemSet(self):
        return list(self._items)

    def FindFootprintByReference(self, ref):
        ref = str(ref)
        for f in self.GetFootprints():
            if f.GetReference() == ref:
                return f
        return None

    FindModuleByReference = FindFootprintByReference
    FindModule = FindFootprintByReference

    def FindFootprintByPath(self, path):
        want = str(path)
        for f in self.GetFootprints():
            if f.GetPath().AsString() == want:
                return f
        return None

    def GetItem(self, kiid):
        it = self._by_id.get(str(kiid))
        if it is not None:
            return it
        want = str(kiid)
        for f in self.GetFootprints():
            for group in f._kids().values():
                for kid in group:
                    if isinstance(kid, BOARD_ITEM) and kid.m_Uuid.AsString() == want:
                        return kid
        return None

    ResolveItem = GetItem

    def GetFootprint(self, pos, layer=UNDEFINED_LAYER, *_):
        for f in self.GetFootprints():
            if f.HitTest(pos) and (layer in (UNDEFINED_LAYER, None) or f.GetLayer() == layer):
                return f
        return None

    def GetPad(self, *a):
        pos = next((x for x in a if isinstance(x, (VECTOR2I, tuple))), None)
        if pos is None:
            return None
        for p in self.GetPads():
            if p.GetBoundingBox().Contains(pos):
                return p
        return None

    def Add(self, item, *_):
        if isinstance(item, (NETINFO_ITEM,)):
            self._net_code(item.GetNetname(), create=True)
            item._code = self._net_codes[item.GetNetname()]
            return
        if not isinstance(item, BOARD_ITEM):
            return
        uid = item.m_Uuid.AsString()
        if uid in self._by_id:
            return
        item._board, item._parent = self, None
        if item.__dict__.get("_net_wanted") is not None:
            item._write_net(item._net_wanted)
        if isinstance(item, FOOTPRINT):
            item._kids_cache = None
            if not self._nets_by_name_only:         # pads given a net by name before the footprint had a board
                for pad in item.Pads():
                    k = _kid(pad._node, "net")
                    if k is not None and len(k) == 2 and not isinstance(k[1], Sym):
                        _drop_kid(pad._node, "net")
                        pad._write_net(str(k[1]))
            if item._pending:                       # a new footprint is written where it was asked to be
                p = item._pending
                item._pending = None
                item._write_placement(p)
        self._items.append(item)
        self._by_id[uid] = item
        item._flags |= IS_NEW
        self._modified = True

    AddNative = Add

    def Remove(self, item, *_):
        if item is None:
            return
        if isinstance(item, NETINFO_ITEM):
            code = self._net_codes.pop(item.GetNetname(), None)
            if code:
                self._net_names.pop(code, None)
                self._modified = True
            return
        if isinstance(item, FOOTPRINT) or item._parent is None:
            uid = item.m_Uuid.AsString()
            if self._by_id.get(uid) is None:
                return
            self._items = [it for it in self._items if it._node is not item._node]
            del self._by_id[uid]
            if uid in self._original:
                self._removed.append(uid)
            self._modified = True
        else:
            item._parent.Remove(item)

    Delete = Remove
    RemoveNative = Remove
    DeleteStructure = Remove

    def RemoveAll(self, *_):
        for it in list(self._items):
            self.Remove(it)

    def DeleteAllFootprints(self):
        for f in self.GetFootprints():
            self.Remove(f)

    def Duplicate(self, item, add=False):
        d = item.Duplicate()
        if add:
            self.Add(d)
        return d

    def IsEmpty(self):
        return not self._items

    def IsFootprintHolder(self):
        return False

    # -- layers
    def _copper_layers(self):
        cu = [i for i, name, _t, _u in self._layers if name.endswith(".Cu")]
        if not cu:
            return [F_Cu, B_Cu]
        if self._version and self._version < 20241228:      # before KiCad 9 the file numbered layers differently
            cu = [_LAYER_IDS[name] for _i, name, _t, _u in self._layers if name.endswith(".Cu") and name in _LAYER_IDS]
        return [l for l in _CU_ORDER if l in cu]

    def GetCopperLayerCount(self):
        return len(self._copper_layers())

    def SetCopperLayerCount(self, count):
        """This board's own copper layers: front, back and the inner ones between (see SetEnabledLayers)."""
        count = max(1, int(count))
        want = [F_Cu] + _CU_ORDER[1:max(1, count - 1)] + ([B_Cu] if count > 1 else [])
        have = {i: row for i, *row in self._layers}
        if not self._layers:
            if count == 2:
                return
            have = {i: (_layer_name(i), "user", "") for i in LSET.AllLayersMask()._s if not IsCopperLayer(i)}
        rows = [(i,) + tuple(have.get(i, (_layer_name(i), "signal", ""))) for i in want]
        self._layers = rows + [(i,) + tuple(r) for i, r in have.items() if not IsCopperLayer(i)]
        self._sync_layers()

    def _sync_layers(self):
        """Write the layer list back into the file's `layers` block."""
        if not getattr(self, "_head", None):
            self._head = [[Sym("version"), 20241229], [Sym("generator"), "pcbnew"], [Sym("generator_version"), "10.0"]]
        node = [Sym("layers")] + [[_n(i), name, Sym(t or "user")] + ([user] if user else []) for i, name, t, user in self._layers]
        for h in self._head:
            if h and h[0] == "layers":
                h[:] = node
                break
        else:
            at = 0
            for i, h in enumerate(self._head):
                if h and h[0] in ("version", "generator", "generator_version", "general", "paper", "title_block"):
                    at = i + 1
            self._head.insert(at, node)
        if _Host.board is self:
            _logging.getLogger("kicad_web").warning("The layers changed in the plugin's copy of the board; change them in Board Setup for the editor to follow.")

    def GetEnabledLayers(self):
        if not self._layers:
            return LSET.AllLayersMask()
        return LSET([_LAYER_IDS[name] for _i, name, _t, _u in self._layers if name in _LAYER_IDS])

    def GetVisibleLayers(self):
        return self.GetEnabledLayers()

    GetLayerSet = GetEnabledLayers

    def IsLayerEnabled(self, layer):
        return int(layer) in self.GetEnabledLayers()._s

    def IsLayerVisible(self, layer):
        return self.IsLayerEnabled(layer)

    def GetLayerName(self, layer):
        std = _layer_name(layer)
        for _i, name, _t, user in self._layers:
            if name == std and user:
                return user
        return _ui_layer_name(_layer_id(std)) if std in _LAYER_IDS else std

    GetStandardLayerName = staticmethod(lambda layer: _ui_layer_name(layer))

    def GetVisibleElements(self):
        return _ItemList()

    def SetVisibleElements(self, *_):
        pass

    def GetLayerID(self, name):
        name = str(name)
        for _i, std, _t, user in self._layers:
            if user == name:
                return _layer_id(std)
        return _layer_id(name)

    def GetLayerType(self, layer):
        std = _layer_name(layer)
        for _i, name, t, _u in self._layers:
            if name == std:
                return {"signal": 0, "power": 1, "mixed": 2, "jumper": 3}.get(t, 0)
        return 0

    def FlipLayer(self, layer):
        return FlipLayer(layer)

    def SetLayerName(self, layer, name):
        # kept for this run only: the layer table is part of the board setup, which plugins do not change on the web
        std = _layer_name(layer)
        self._layers = [(i, n, t, str(name) if n == std else u) for i, n, t, u in self._layers]
        self._sync_layers()
        return True

    def SetEnabledLayers(self, layers, *_):
        """This board's own list of layers follows; the editor's layer setup (Board Setup) is the person's to change."""
        want = set(LSET(layers)._s)
        have = {i for i, *_r in self._layers}
        if want == have:
            return
        self._layers = [row for row in self._layers if row[0] in want] + \
            [(i, _layer_name(i), "signal" if IsCopperLayer(i) else "user", None) for i in sorted(want - have)]
        self._sync_layers()

    def ClearProject(self, *_):
        pass

    def SetProperties(self, props):
        self._props = dict(props or {})

    def SetPageSettings(self, *_):
        pass

    def SetTitleBlock(self, tb):
        node = getattr(tb, "_node", None)
        if node is not None and self._title is not None:
            self._title[:] = _copy.deepcopy(node)

    SetVisibleLayers = lambda self, *_: None
    SetElementVisibility = lambda self, *_: None
    IsElementVisible = lambda self, *_: True

    # -- geometry
    def GetBoardEdgesBoundingBox(self):
        b = BOX2I()
        for it in self._items:
            if isinstance(it, PCB_SHAPE) and it.GetLayer() == Edge_Cuts:
                b.Merge(it.GetBoundingBox())
        for f in self.GetFootprints():
            for s in f._kids()["shapes"]:
                if s.GetLayer() == Edge_Cuts:
                    b.Merge(s.GetBoundingBox())
        return b if b._valid else self.ComputeBoundingBox(False)

    def ComputeBoundingBox(self, edges_only=False, *_, aBoardEdgesOnly=None):
        if aBoardEdgesOnly is not None:
            edges_only = aBoardEdgesOnly
        if edges_only:
            return self.GetBoardEdgesBoundingBox()
        b = BOX2I()
        for it in self._items:
            if not isinstance(it, PCB_GROUP):
                b.Merge(it.GetBoundingBox())
        return b

    GetBoundingBox = lambda self, *_: self.ComputeBoundingBox(False)

    def GetBoardPolygonOutlines(self, outlines, *_):
        return False

    def GetFocusPosition(self):
        return self.ComputeBoundingBox().GetCenter()

    # -- settings and file
    def GetDesignSettings(self):
        return BOARD_DESIGN_SETTINGS(self)

    def _section(self, name):
        """The board file's `general` or `setup` block, made when the file has none yet."""
        n = getattr(self, "_" + name)
        if n is None:
            n = [Sym(name)]
            at = 0
            if not getattr(self, "_head", None):
                self._head = [[Sym("version"), 20241229], [Sym("generator"), "pcbnew"], [Sym("generator_version"), "10.0"]]
            for i, h in enumerate(self._head):
                if h and h[0] in ("version", "generator", "generator_version", "general", "paper", "title_block", "layers"):
                    at = i + 1
            self._head.insert(at, n)
            setattr(self, "_" + name, n)
        return n

    def GetTitleBlock(self):
        return TITLE_BLOCK(self._title)

    def GetFileName(self):
        return self._filename

    def SetFileName(self, name):
        self._filename = str(name)

    def GetFileFormatVersionAtLoad(self):
        return self._version

    def GetProperties(self):
        return dict(self._props)

    def GetProject(self):
        return PROJECT(self)

    def GetPlotOptions(self):
        return PCB_PLOT_PARAMS()

    def SetPlotOptions(self, *_):
        pass

    def GetPageSettings(self):
        return None

    def GetTimeStamp(self):
        return 0

    def GetStackupOrDefault(self):
        return BOARD_STACKUP(self)

    def GetBoardUse(self):
        return 0

    def _text(self):
        """The board as a .kicad_pcb file: the header as it arrived, the items as they are now."""
        head = getattr(self, "_head", None) or [[Sym("version"), 20241229], [Sym("generator"), "pcbnew"], [Sym("generator_version"), "10.0"]]
        if not self._nets_by_name_only and any(h and h[0] == "net" for h in head):
            # a file that numbers its nets declares each one: the list follows the nets as they are now
            nets = [[Sym("net"), _n(c), n] for c, n in sorted(self._net_names.items())]
            first = next(i for i, h in enumerate(head) if h and h[0] == "net")
            head = [h for h in head[:first] if not (h and h[0] == "net")] + nets + [h for h in head[first:] if not (h and h[0] == "net")]
        return "(kicad_pcb\n" + "\n".join("  " + _dump(n) for n in list(head) + [it._node for it in self._items if getattr(it, "_node", None) is not None]) + "\n)\n"

    def Save(self, path=None, *_):
        return SaveBoard(path or self._filename, self)

    def SetModified(self):
        self._modified = True

    def IsModified(self):
        return self._modified

    def ClearSelected(self, *_):
        for it in self._items:
            it._selected = False
        self._selection_changed = True

    # ---- net highlight: the nets a plugin asks the editor to show brightly
    def ResetNetHighLight(self):
        self.__dict__["_hl_nets"] = set()
        self.__dict__["_hl_on"] = False
        self._show_highlight()

    def SetHighLightNet(self, code, multi=False):
        nets = self.__dict__.setdefault("_hl_nets", set())
        if not multi:
            nets.clear()
        if int(code) > 0:
            nets.add(int(code))
        if self.__dict__.get("_hl_on"):
            self._show_highlight()

    def GetHighLightNetCodes(self):
        return set(self.__dict__.get("_hl_nets", ()))

    def GetHighLightNetCode(self):
        return next(iter(sorted(self.__dict__.get("_hl_nets", ()))), -1)

    def IsHighLightNetON(self):
        return bool(self.__dict__.get("_hl_on"))

    def HighLightON(self, on=True):
        self.__dict__["_hl_on"] = bool(on)
        self._show_highlight()

    def HighLightOFF(self):
        self.HighLightON(False)

    def _show_highlight(self):
        if _Host.highlight is None or self is not _Host.board:
            return
        codes = self.__dict__.get("_hl_nets", set()) if self.__dict__.get("_hl_on") else set()
        _Host.highlight(sorted(self._net_names[c] for c in codes if self._net_names.get(c)))

    def GetCurrentSelection(self):
        return [it for it in self._items if it._selected] + [k for f in self.GetFootprints() for g in (f._kids_cache or {}).values() for k in g if isinstance(k, BOARD_ITEM) and k._selected]

    def SanitizeNetcodes(self):
        pass

    def OnRatsnestChanged(self):
        pass

    def UpdateRatsnestExclusions(self):
        pass

    def GetNodesCount(self, *_):
        return len(self.GetPads())

    def GetTrackLength(self, track):
        return 1, float(track.GetLength()), 0.0

    def TracksInNet(self, code):
        return [t for t in self.GetTracks() if t.GetNetCode() == code]

    def GetViasDimensionsList(self):
        return []

    def GetTrackWidthList(self):
        return [FromMM(0.25)]

    def GetNetClassAssignmentCandidates(self):
        return sorted(n for n in self._net_codes if n)

    # -- what goes back to the editor
    def _changes(self):
        """The edit this plugin run amounts to: items to create, to rewrite, to move and to remove."""
        create, update, transform = [], [], []
        for it in self._items:
            uid = it.m_Uuid.AsString()
            if uid not in self._original:
                create.append(_dump(it._node))
                continue
            if it._dirty:
                pending = getattr(it, "_pending", None)
                if it._content_dirty() if isinstance(it, FOOTPRINT) else True:
                    update.append({"id": uid, "sexpr": _dump(it._node)})
                if pending:
                    transform.append({"id": uid, "x": pending["x"], "y": pending["y"], "rotation": pending["rotation"], "side": pending["side"]})
        select = None
        if self._selection_changed:
            select = [it.m_Uuid.AsString() for it in self._items if it._selected]
        return {"create": create, "update": update, "transform": transform, "remove": list(self._removed), "select": select, "refill": self._wants_refill}

    def _committed(self):
        """After the editor took the changes: what is on the board now is the new starting point."""
        self._modified = False
        self._removed = []
        self._selection_changed = False
        self._wants_refill = False
        self._original = {}
        for it in self._items:
            it._dirty = False
            self._original[it.m_Uuid.AsString()] = it


def _fp_content_dirty(self):
    return getattr(self, "_content", False)


FOOTPRINT._content_dirty = _fp_content_dirty
_fp_touch = BOARD_ITEM._touch


def _footprint_touch(self):
    _fp_touch(self)


def _child_touch(self):
    top = self._parent if self._parent is not None else self
    top._dirty = True
    top._content = True                     # something inside the node changed, so the node itself is rewritten
    if self._board is not None:
        self._board._modified = True


BOARD_ITEM._touch = _child_touch


def _fp_place(self, **kw):
    if self._pending is None:
        x, y, r = self._stored()
        self._pending = {"x": x, "y": y, "rotation": r, "side": self._stored_side()}
    self._pending.update(kw)
    self._dirty = True
    if self._board is not None:
        self._board._modified = True


FOOTPRINT._place = _fp_place


def _fp_write_placement(self, p):
    """For a footprint that is not on the board yet: write where it goes into its own node."""
    at = _kid(self._node, "at")
    rot = p["rotation"]
    old = self._stored_rot()
    _set_kid(self._node, "at", p["x"], p["y"], *([rot] if rot else []))
    if rot != old:
        for c in self._node:
            if isinstance(c, list) and c and c[0] in ("pad", "fp_text", "property"):
                a = _kid(c, "at")
                if a is not None and len(a) >= 3:
                    cur = _f(a[3]) if len(a) > 3 and not isinstance(a[3], list) and str(a[3]) != "unlocked" else 0.0
                    tail = [x for x in a[3:] if str(x) == "unlocked"]
                    new = (cur + rot - old) % 360.0
                    a[:] = a[:3] + ([_n(new)] if new or tail else []) + tail
    self._content = True
    self._dirty = True


FOOTPRINT._write_placement = _fp_write_placement


class PROJECT:
    def __init__(self, board):
        self._board = board

    def GetProjectPath(self):
        import os
        return os.path.dirname(self._board.GetFileName()) + "/"

    def GetProjectName(self):
        import os
        return os.path.splitext(os.path.basename(self._board.GetFileName()))[0]

    def GetProjectFullName(self):
        import os
        return os.path.splitext(self._board.GetFileName())[0] + ".kicad_pro"

    def AbsolutePath(self, name):
        import os
        return os.path.join(self.GetProjectPath(), name)

    def GetTextVars(self):
        return {}

    def GetProjectFile(self):
        return self


# ----------------------------------------------------------------------------- the running editor

ID_ON_GRID_SELECT = 6211       # the grid selector of the board editor's toolbar (wx.FindWindowById finds a stand-in)
ID_ON_ZOOM_SELECT = 6210


class _Host:
    """What the runtime (web/plugins/pyruntime.ts) sets before it calls a plugin."""
    grid_mm = 0.25           # the editor's current grid
    board = None
    refresh = None           # called by Refresh(): pushes the changes so far to the editor
    focus = None
    highlight = None         # called with the names of the nets to show brightly (none: no highlight)
    version = "10.0.0"
    kicad6 = False           # set once a plugin uses an interface only KiCad 6 has: it is then answered in KiCad 6's terms (SVG plot units)
    plugins = []             # registered ActionPlugins
    plugin_dir = "/plugins"
    config_dir = "/config"
    project = {}             # the open project's .kicad_pro, parsed: net classes and design rules
    on_register = None
    library = None           # callable(what, args): KiCad's footprint libraries, read through the editor
    wizards = []             # registered footprint wizards
    on_register_wizard = None


def GetBoard():
    if _Host.board is None:
        _Host.board = BOARD()
    return _Host.board


def Refresh():
    if _Host.refresh is not None:
        _Host.refresh()


def UpdateUserInterface():
    pass


def FocusOnItem(item, *_):
    if _Host.focus is not None and item is not None:
        _Host.focus(item)


def GetCurrentSelection():
    return GetBoard().GetCurrentSelection()


def LoadBoard(path, *_):
    b = _Host.board
    if b is not None and str(path) == b.GetFileName():
        return b
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return BOARD(fh.read(), str(path))
    except OSError:
        _unsupported(f"Opening another board file ({path})")


def SaveBoard(path, board, *_):
    """Saving to the board's own file sends the changes so far to the editor (which saves every change as it is made); the
    file itself is written too, in this interpreter's file system, where the plugin and what it starts can read it.  Saving
    under another name writes a copy there."""
    import os as _os
    path = str(path or board._filename or "")
    if not path:
        _unsupported("Saving a board that has no file name")
    if not _os.path.isabs(path):
        path = _os.path.join(_os.path.dirname(board._filename or "") or _os.getcwd(), path)
    own = _os.path.abspath(path) == _os.path.abspath(board._filename or "")
    if own and board is _Host.board and _Host.refresh is not None:
        _Host.refresh()
    d = _os.path.dirname(path)
    if d:
        _os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(board._text())
    if own:
        board._modified = False
    return True


def NewBoard(path=""):
    return BOARD(None, str(path))


CreateEmptyBoard = lambda: BOARD()


def ExpandTextVars(text, *_):
    return str(text)


def ExpandEnvVarSubstitutions(text, *_):
    import os
    return os.path.expandvars(str(text))


def GetBuildVersion():
    return _Host.version


FullVersion = GetBuildVersion
GetSemanticVersion = GetBuildVersion
GetBaseVersion = GetBuildVersion
GetMajorMinorPatchVersion = GetBuildVersion


def Version():
    return _Host.version


def GetMajorMinorVersion():
    return ".".join(_Host.version.split(".")[:2])


def GetMajorMinorPatchTuple():
    return tuple(int(_re.sub(r"\D.*", "", p) or 0) for p in (_Host.version.split(".") + ["0", "0"])[:3])


def GetCommitHash():
    return "web"


def GetPlatformGetBitnessName():
    return "wasm32"


def IsNightlyVersion():
    return False


def IsActionRunning():
    return True


def GetKicadConfigPath():
    return _Host.config_dir


def GetUserUnits():
    return EDA_UNITS_MILLIMETRES


def GetLanguage():
    return "en"


def GetWizardsSearchPaths():
    return []


def Cast_to_BOARD_ITEM(item):
    return item


Cast_to_FOOTPRINT = Cast_to_PCB_TEXT = Cast_to_PCB_SHAPE = Cast_to_PAD = Cast_to_ZONE = Cast_to_PCB_TRACK = Cast_to_PCB_VIA = Cast_to_BOARD_ITEM
Cast_to_PCB_ARC = Cast_to_PCB_GROUP = Cast_to_PCB_DIM_ALIGNED = Cast_to_PCB_DIM_ORTHOGONAL = Cast_to_PCB_TEXTBOX = Cast_to_BOARD_ITEM


class UNITS_PROVIDER:
    def __init__(self, scale=None, units=None):
        self._scale, self._units = scale, EDA_UNITS_MILLIMETRES if units is None else units

    def GetUserUnits(self):
        return self._units

    def SetUserUnits(self, units):
        self._units = units

    def GetIuScale(self):
        return self._scale

    def StringFromValue(self, value, add_units=False, *_):
        inch = self._units in (EDA_UNITS_INCHES, EDA_UNITS_MILS)
        v = ToMM(value) / 25.4 * (1000 if self._units == EDA_UNITS_MILS else 1) if inch else ToMM(value)
        t = ("%.4f" % v).rstrip("0").rstrip(".")
        return t + ((" mils" if self._units == EDA_UNITS_MILS else " in") if inch else " mm") if add_units else t

    MessageTextFromValue = StringFromValue

    def ValueFromString(self, text, *_):
        m = _re.match(r"\s*(-?[0-9.]+)\s*(\w*)", str(text))
        if not m:
            return 0
        v, u = float(m.group(1)), m.group(2).lower()
        u = u or {EDA_UNITS_INCHES: "in", EDA_UNITS_MILS: "mils"}.get(self._units, "mm")
        return FromMM(v * 25.4) if u in ("in", "inch", '"') else FromMM(v * 0.0254) if u in ("mil", "mils", "thou") else FromMM(v)


def GetSettingsManager():
    return SETTINGS_MANAGER()


def PlotDrawingSheet(*_):
    _unsupported("PlotDrawingSheet")


class SETTINGS_MANAGER:
    def __init__(self, *_):
        pass

    @staticmethod
    def GetUserSettingsPath():
        return _Host.config_dir

    @staticmethod
    def SaveProject(*_):
        """The web editor saves the project's settings as they change; there is nothing left to write."""
        return True

    @staticmethod
    def IsProjectOpen():
        return _Host.board is not None

    @staticmethod
    def GetSettingsVersion():
        return GetMajorMinorVersion()

    @staticmethod
    def GetColorSettingsPath():
        return _Host.config_dir + "/colors"

    def GetProject(self, *_):
        return PROJECT(GetBoard())

    def LoadProject(self, *_):
        """Projects are the editor's: the one open is the one loaded."""
        return True

    def UnloadProject(self, *_):
        return True

    def SaveProject(self, *_):
        return True

    def Prj(self):
        return PROJECT(GetBoard())

    def GetColorSettings(self, *_):
        return None

    def GetCommonSettings(self):
        return None

    def Load(self, *_):
        return True

    def Save(self, *_):
        pass


# ----------------------------------------------------------------------------- footprint libraries
# KiCad's official footprint libraries are read through the editor (the server keeps them: src/libs.rs).  They are
# read-only here, as they are on a desktop where they are installed system-wide.

FOOTPRINT_DIR = "/usr/share/kicad/footprints"


def _lib_nick(lib):
    """A library by nickname ("Connector_Wire") or by its folder (".../footprints/Connector_Wire.pretty")."""
    s = str(lib or "").replace("\\", "/").rstrip("/")
    s = s.split("/")[-1]
    return s[:-7] if s.endswith(".pretty") else s


def _library(what, **args):
    if _Host.library is None:
        _unsupported("The footprint libraries")
    return _Host.library(what, args)


def FootprintLoad(lib, name, *_):
    """The footprint `name` of a library, as a FOOTPRINT that is not on a board yet; None when there is none."""
    import os
    path = os.path.join(str(lib), str(name) + ".kicad_mod")
    if os.path.isfile(path):                # a library folder the plugin brought with it
        with open(path, encoding="utf-8") as f:
            text = f.read()
    else:
        r = _library("footprint", lib=_lib_nick(lib), name=str(name))
        text = (r or {}).get("footprint")
    if not text:
        return None
    return _footprint_from_text(text, _lib_nick(lib), name)


def _footprint_from_text(text, lib="", name=""):
    """A FOOTPRINT that is not on a board yet, from the text of a .kicad_mod file or of a footprint on KiCad's clipboard."""
    node = _parse(text)[0]
    if node and node[0] == "module":        # a library file from before KiCad 6: the same footprint under its old name
        node[0] = Sym("footprint")
        node[:] = [k for k in node if not (isinstance(k, list) and k and k[0] in ("tedit", "tstamp"))]
        if len(node) > 1 and not isinstance(node[1], list):
            node[1] = str(node[1])
    if _kid(node, "at") is None:
        node.insert(2, [Sym("at"), _n(0), _n(0)])
    if len(node) > 1 and not isinstance(node[1], list) and name:
        node[1] = "%s:%s" % (lib, name)

    def new_ids(n):         # every copy placed on a board is its own item, with its own ids
        for k in n:
            if isinstance(k, list) and k:
                if str(k[0]) == "uuid" and len(k) > 1:
                    k[1] = str(_uuid.uuid4())
                else:
                    new_ids(k)
    new_ids(node)
    if _kid(node, "uuid") is None:
        _set_kid(node, "uuid", str(_uuid.uuid4()))
    fp = FOOTPRINT._wrap(node, None)
    fp._library = lib
    return fp


def FootprintEnumerate(lib, *_):
    import os
    if os.path.isdir(str(lib)):
        return sorted(f[:-10] for f in os.listdir(str(lib)) if f.endswith(".kicad_mod"))
    r = _library("footprints", lib=_lib_nick(lib))
    return [str(n) for n in (r or {}).get("footprints", [])]


def GetFootprintLibraries(*_):
    r = _library("libraries")
    return [str(n) for n in (r or {}).get("libraries", [])]


def GetFootprints(lib, *_):
    return FootprintEnumerate(lib)


def _lib_read_only(*_):
    _unsupported("Writing to KiCad's footprint libraries (they are read-only in the web editor)")


FootprintLibDelete = FootprintLibCreate = FootprintSave = FootprintDelete = _lib_read_only
FootprintIsWritable = lambda *_: False
GetFootprintLibraryTable = lambda *_: _unsupported("The footprint library table")


class ActionPlugin:
    """A command a plugin adds to the board editor.  Subclasses set name / category / description in
    defaults() and do their work in Run(), as on the desktop."""

    def __init__(self):
        self.name = "Undefined Action plugin"
        self.category = "Undefined"
        self.description = ""
        self.icon_file_name = ""
        self.dark_icon_file_name = ""
        self.show_toolbar_button = False
        self.__plugin_path = ""
        self.defaults()

    def defaults(self):
        pass

    def register(self):
        import inspect
        try:
            self.__plugin_path = inspect.getfile(self.__class__)
        except (TypeError, OSError):
            pass
        if not any(p is self or (type(p) is type(self) and p.name == self.name) for p in _Host.plugins):
            _Host.plugins.append(self)
            if _Host.on_register is not None:
                _Host.on_register(self)

    def deregister(self):
        if self in _Host.plugins:
            _Host.plugins.remove(self)

    def GetName(self):
        return self.name

    def GetCategoryName(self):
        return self.category

    def GetDescription(self):
        return self.description

    def GetShowToolbarButton(self):
        return self.show_toolbar_button

    def GetIconFileName(self, dark=False):
        return self.dark_icon_file_name if dark and self.dark_icon_file_name else self.icon_file_name

    def GetPluginPath(self):
        return self.__plugin_path

    def Run(self):
        pass


class KiCadPlugin(ActionPlugin):
    pass


class FilePlugin(ActionPlugin):
    pass


uMM, uMils, uFloat, uInteger, uBool, uRadians, uDegrees, uPercent, uString = "mm", "mils", "float", "integer", "bool", "radians", "degrees", "%", "string"
uNumeric = [uMM, uMils, uFloat, uInteger, uDegrees, uRadians, uPercent]
uUnits = [uMM, uMils, uFloat, uInteger, uBool, uDegrees, uRadians, uPercent, uString]


class FootprintWizardParameter:
    """One value of a footprint wizard: its page, name, unit, limits and what the person typed."""

    _true = ["true", "t", "y", "yes", "on", "1", 1]
    _false = ["false", "f", "n", "no", "off", "0", 0, "", None]
    _bools = _true + _false

    def __init__(self, page, name, units, default, **kwarg):
        self.page = page
        self.name = name
        self.hint = kwarg.get("hint", "")
        self.designator = kwarg.get("designator", " ")
        if isinstance(units, (list, tuple)):
            self.units = ",".join(str(el).strip() for el in units)
        elif str(units).lower() in uUnits:
            self.units = str(units).lower()
        elif str(units).lower() == "percent":
            self.units = uPercent
        else:
            self.units = units
        self.multiple = int(kwarg.get("multiple", 1))
        self.min_value = kwarg.get("min_value", None)
        self.max_value = kwarg.get("max_value", None)
        self.raw_value = ""
        self.SetValue(default)
        self.default = self.raw_value
        self.error_list = []

    def ClearErrors(self):
        self.error_list = []

    def AddError(self, err, info=None):
        if err in self.error_list:
            return
        self.error_list.append("{err} ({info})".format(err=err, info=info) if info is not None else err)

    def Check(self, min_value=None, max_value=None, multiple=None, info=None):
        if min_value is None:
            min_value = self.min_value
        if max_value is None:
            max_value = self.max_value
        if multiple is None:
            multiple = self.multiple
        if self.units not in uUnits and "," not in str(self.units):
            self.AddError("type '{t}' unknown".format(t=self.units), info)
            self.AddError("Allowable types: " + str(self.units), info)
        if self.units in uNumeric:
            try:
                to_num = float(self.raw_value)
                if min_value is not None and to_num < min_value:
                    self.AddError("value '{v}' is below minimum ({m})".format(v=self.raw_value, m=min_value), info)
                if max_value is not None and to_num > max_value:
                    self.AddError("value '{v}' is above maximum ({m})".format(v=self.raw_value, m=max_value), info)
            except (TypeError, ValueError):
                self.AddError("value '{v}' is not of type '{t}'".format(v=self.raw_value, t=self.units), info)
        if self.units == uInteger:
            try:
                to_int = int(float(self.raw_value))
                if multiple is not None and multiple > 1 and to_int % multiple > 0:
                    self.AddError("value '{v}' is not a multiple of {m}".format(v=self.raw_value, m=multiple), info)
            except (TypeError, ValueError):
                self.AddError("value '{v}' is not an integer".format(v=self.raw_value), info)
        if self.units == uBool and self.raw_value not in ("0", "1"):
            self.AddError("value '{v}' is not a boolean value".format(v=self.raw_value), info)

    @property
    def value(self):
        v = str(self.raw_value)
        if self.units in uNumeric:
            try:
                v = float(v.replace(",", "."))
            except ValueError:
                v = 0.0
            if self.units == uInteger:
                return int(v)
            if self.units == uMM:
                return FromMM(v)
            if self.units == uMils:
                return FromMils(v)
            return v
        if self.units == uBool:
            return v.lower() in self._true
        return v

    def DefaultValue(self):
        return str(self.default)

    def SetValue(self, new_value):
        new_value = str(new_value)
        if len(new_value.strip()) == 0 and self.units not in (uString, uBool):
            return
        if self.units == uBool:
            new_value = "1" if new_value.lower() in self._true else "0"
        elif self.units in uNumeric:
            new_value = new_value.replace(",", ".")
        elif "," in str(self.units) and new_value not in str(self.units).split(","):
            new_value = str(self.units).split(",")[0]
        self.raw_value = new_value

    def __str__(self):
        s = self.name + ": " + str(self.raw_value)
        if self.units in (uMM, uMils, uPercent, uRadians, uDegrees):
            s += self.units
        elif self.units == uBool:
            s = self.name + ": " + ("True" if self.raw_value == "1" else "False")
        elif self.units == uString:
            s = self.name + ": '" + self.raw_value + "'"
        return s


class FootprintWizardPlugin(KiCadPlugin):
    """A footprint wizard as KiCad registers it.  The web editor offers each one as a command that opens the wizard dialog."""

    def __init__(self):
        self.module = None
        self.params = []
        self.name = "KiCad FP Wizard"
        self.description = "Undefined Footprint Wizard plugin"
        self.image = ""
        self.buildmessages = ""
        self.category = "Footprint Wizard"
        self.icon_file_name = self.dark_icon_file_name = ""
        self.show_toolbar_button = False
        self.defaults()

    def defaults(self):
        pass

    def register(self):
        try:
            self.name = str(self.GetName())
            self.description = str(self.GetDescription())
        except NotImplementedError:
            pass
        if not any(type(w) is type(self) for w in _Host.wizards):
            _Host.wizards.append(self)
            if _Host.on_register_wizard is not None:
                _Host.on_register_wizard(self)

    def deregister(self):
        if self in _Host.wizards:
            _Host.wizards.remove(self)

    def AddParam(self, page, name, unit, default, **kwarg):
        self.params.append(FootprintWizardParameter(page, name, unit, default, **kwarg))

    @property
    def parameters(self):
        pages = {}
        for p in self.params:
            pages.setdefault(p.page, {})[p.name] = p.value
        return pages

    @property
    def values(self):
        return self.parameters

    @property
    def pages(self):
        page_list = []
        for p in self.params:
            if p.page not in page_list:
                page_list.append(p.page)
        return page_list

    def GetName(self):
        return self.name

    def GetImage(self):
        return self.image

    def GetDescription(self):
        return self.description

    def GetValue(self):
        raise NotImplementedError

    def GetReferencePrefix(self):
        return "REF"

    def GetParam(self, page, name):
        for p in self.params:
            if p.page == page and p.name == name:
                return p
        return None

    def CheckParam(self, page, name, **kwarg):
        self.GetParam(page, name).Check(**kwarg)

    def AnyErrors(self):
        return any(len(p.error_list) > 0 for p in self.params)

    def GetNumParameterPages(self):
        return len(self.pages)

    def GetParameterPageName(self, page_n):
        return self.pages[page_n]

    def GetParametersByPageName(self, page_name):
        return [p for p in self.params if p.page == page_name]

    def GetParametersByPageIndex(self, page_index):
        return self.GetParametersByPageName(self.GetParameterPageName(page_index))

    def GetParameterDesignators(self, page_index):
        return [p.designator for p in self.GetParametersByPageIndex(page_index)]

    def GetParameterNames(self, page_index):
        return [p.name for p in self.GetParametersByPageIndex(page_index)]

    def GetParameterValues(self, page_index):
        return [str(p.raw_value) for p in self.GetParametersByPageIndex(page_index)]

    def GetParameterErrors(self, page_index):
        return [str("\n".join(p.error_list)) for p in self.GetParametersByPageIndex(page_index)]

    def GetParameterTypes(self, page_index):
        return [str(p.units) for p in self.GetParametersByPageIndex(page_index)]

    def GetParameterHints(self, page_index):
        return [str(p.hint) for p in self.GetParametersByPageIndex(page_index)]

    def SetParameterValues(self, page_index, list_of_values):
        params = self.GetParametersByPageIndex(page_index)
        for i, param in enumerate(params):
            if i < len(list_of_values):
                param.SetValue(list_of_values[i])

    def ResetWizard(self):
        for p in self.params:
            p.raw_value = p.default
            p.ClearErrors()

    def GetFootprint(self):
        self.BuildFootprint()
        return self.module

    def BuildFootprint(self):
        return

    def GetBuildMessages(self):
        return self.buildmessages

    def Show(self):
        text = "Footprint Wizard Name:        {name}\n".format(name=self.GetName())
        text += "Footprint Wizard Description: {desc}\n".format(desc=self.GetDescription())
        n_pages = self.GetNumParameterPages()
        text += "Pages: {n}\n".format(n=n_pages)
        for i in range(n_pages):
            name = self.GetParameterPageName(i)
            params = self.GetParametersByPageName(name)
            text += "{name}\n".format(name=name)
            for j in range(len(params)):
                text += ("\t{param}{err}\n".format(param=str(params[j]), err=" *" if len(params[j].error_list) > 0 else ""))
        if self.AnyErrors():
            text += " * Errors exist for these parameters"
        return text


FootprintWizard = FootprintWizardPlugin


class PCB_PLOT_PARAMS:
    # the drill mark names of KiCad 6, which older plugins still use
    NO_DRILL_SHAPE, SMALL_DRILL_SHAPE, FULL_DRILL_SHAPE = 0, 1, 2
    """Plot settings a plugin fills in.  They are kept and handed to the editor's fabrication output."""

    def __init__(self):
        self.__dict__["_v"] = {
            "OutputDirectory": "", "Format": PLOT_FORMAT_GERBER, "PlotFrameRef": False, "PlotValue": True, "PlotReference": True,
            "PlotInvisibleText": False, "PlotViaOnMaskLayer": False, "ExcludeEdgeLayer": True, "Mirror": False, "Negative": False,
            "UseGerberProtelExtensions": False, "UseGerberX2format": True, "IncludeGerberNetlistInfo": True, "CreateGerberJobFile": False,
            "SubtractMaskFromSilk": False, "UseAuxOrigin": False, "DrillMarksType": DRILL_MARKS_NO_DRILL_SHAPE, "AutoScale": False,
            "Scale": 1.0, "GerberPrecision": 6, "SketchPadsOnFabLayers": False, "PlotFPText": True, "DisableGerberMacros": False,
            "SvgPrecision": 4, "BlackAndWhite": True, "PlotOnAllLayersSelection": LSET(), "PlotOnAllLayersSequence": [],
            "LayerSelection": LSET(), "TextMode": PLOT_TEXT_MODE_DEFAULT, "ScaleSelection": 1, "A4Output": False, "DXFPlotPolygonMode": True,
            "DXFPlotUnits": 0, "FineScaleAdjustX": 1.0, "FineScaleAdjustY": 1.0, "WidthAdjust": 0, "PlotMode": 1, "PlotPadsOnSilkLayer": False,
            "HPGLPenNum": 1, "HPGLPenSpeed": 20, "HPGLPenDiameter": 15.0, "ColorSettings": None, "PDFFrontFPPropertyPopups": True,
            "PDFBackFPPropertyPopups": True, "PDFMetadata": True, "SketchDNPFPsOnFabLayers": True, "HideDNPFPsOnFabLayers": False,
            "CrossoutDNPFPsOnFabLayers": True, "PlotPadNumbers": False, "DashedLineDashRatio": 12.0, "DashedLineGapRatio": 3.0,
            "SvgFitPageToBoard": False, "PDFSingle": False, "PlotInteractive": False,
        }

    def __getattr__(self, name):
        v = self.__dict__["_v"]
        if name.startswith("Set") and len(name) > 3:
            key = name[3:]
            return lambda *a: v.__setitem__(key, a[0] if len(a) == 1 else a)
        if name.startswith("Get") and len(name) > 3:
            key = name[3:]
            return lambda *a: v.get(key)
        if name.startswith("m_"):
            return v.get(name[2:])
        raise AttributeError(name)

    def IsSameAs(self, other):
        return self._v == other._v

    def Parse(self, *_):
        pass

    def Format(self, *_):
        pass


class _Fabrication:
    """Plotting and drill files are produced by the editor's own fabrication output.  The runtime sets
    `plot` and `drill` when that is available; until then a plugin that asks is told why it cannot."""
    plot = None
    drill = None
    report = None
    positions = None


class PLOT_CONTROLLER:
    def __init__(self, board):
        self._board = board
        self._opts = PCB_PLOT_PARAMS()
        self._layer = F_Cu
        self._open = None
        self._last = ""

    def GetPlotOptions(self):
        return self._opts

    def SetLayer(self, layer):
        self._layer = int(layer)

    def GetLayer(self):
        return self._layer

    def SetColorMode(self, *_):
        pass

    def GetColorMode(self):
        return False

    def OpenPlotfile(self, suffix, fmt, sheet_desc="", *_):
        self._open = (str(suffix), int(fmt), str(sheet_desc))
        self._layers = []
        return True

    def PlotLayer(self):
        return self.PlotLayers([self._layer])

    def PlotLayers(self, layers):
        if self._open is None:
            return False
        if _Fabrication.plot is None:
            _unsupported("Plotting (Gerber, SVG, PDF, DXF)")
        self._last = _Fabrication.plot(self._board, self._opts._v, [int(l) for l in layers], self._open[0], self._open[1], self._open[2])
        return True

    def ClosePlot(self):
        self._open = None

    def IsPlotOpen(self):
        return self._open is not None

    def GetPlotFileName(self):
        return self._last

    def GetPlotDirName(self):
        import os
        return os.path.dirname(self._last)

    def GetPlotter(self):
        return None


class _DrillWriter:
    _KIND = "excellon"

    def __init__(self, board):
        self._board = board
        self._opts = {"mirror": False, "minimalHeader": False, "offset": VECTOR2I(0, 0), "mergeNPTH": False, "metric": True,
                      "zerosFormat": 0, "leftDigits": 0, "rightDigits": 0, "routeMode": True, "mapFormat": PLOT_FORMAT_PDF}

    def SetOptions(self, mirror=False, minimal_header=False, offset=None, merge_npth=False):
        self._opts.update(mirror=bool(mirror), minimalHeader=bool(minimal_header), offset=offset or VECTOR2I(0, 0), mergeNPTH=bool(merge_npth))

    def SetFormat(self, metric=True, zeros=0, left=0, right=0):
        self._opts.update(metric=bool(metric), zerosFormat=int(zeros), leftDigits=int(left), rightDigits=int(right))

    def SetRouteModeForOvalHoles(self, on):
        self._opts["routeMode"] = bool(on)

    def SetMapFileFormat(self, fmt):
        self._opts["mapFormat"] = fmt

    def SetPageInfo(self, *_):
        pass

    def SetMergeOption(self, on):
        self._opts["mergeNPTH"] = bool(on)

    def GetOffset(self):
        return self._opts["offset"]

    def CreateDrillandMapFilesSet(self, directory, drill=True, map_file=False, *_):
        if _Fabrication.drill is None:
            _unsupported("Drill files")
        return _Fabrication.drill(self._board, self._KIND, self._opts, str(directory), bool(drill), bool(map_file))

    def GenDrillReportFile(self, path, *_):
        if _Fabrication.report is None:
            _unsupported("The drill report")
        return _Fabrication.report(self._board, self._opts, str(path))


class EXCELLON_WRITER(_DrillWriter):
    ZEROS_FMT_DECIMAL, ZEROS_FMT_SUPPRESS_LEADING, ZEROS_FMT_SUPPRESS_TRAILING, ZEROS_FMT_KEEP = 0, 1, 2, 3
    DECIMAL_FORMAT, SUPPRESS_LEADING, SUPPRESS_TRAILING, KEEP_ZEROS = 0, 1, 2, 3


class GERBER_WRITER(_DrillWriter):
    _KIND = "gerber"


GENDRILL_WRITER_BASE = _DrillWriter
GENDRILL_WRITER_BASE.ZEROS_FMT_DECIMAL, GENDRILL_WRITER_BASE.ZEROS_FMT_SUPPRESS_LEADING = 0, 1
GENDRILL_WRITER_BASE.ZEROS_FMT_SUPPRESS_TRAILING, GENDRILL_WRITER_BASE.ZEROS_FMT_KEEP = 2, 3
GENDRILL_WRITER_BASE.DECIMAL_FORMAT, GENDRILL_WRITER_BASE.SUPPRESS_LEADING = 0, 1
GENDRILL_WRITER_BASE.SUPPRESS_TRAILING, GENDRILL_WRITER_BASE.KEEP_ZEROS = 2, 3


class PLACE_FILE_EXPORTER:
    def __init__(self, board, metric=True, smd_only=False, exclude_th=False, exclude_dnp=False, top=True, bottom=True, csv=True, aux=False, negate_bottom_x=False):
        self._board = board
        self._opts = {"metric": bool(metric), "smdOnly": bool(smd_only), "excludeTH": bool(exclude_th), "excludeDNP": bool(exclude_dnp),
                      "top": bool(top), "bottom": bool(bottom), "csv": bool(csv), "useAuxOrigin": bool(aux), "negateBottomX": bool(negate_bottom_x)}

    def GenPositionData(self):
        if _Fabrication.positions is None:
            _unsupported("The component placement file")
        return _Fabrication.positions(self._board, self._opts)

    def GenReportData(self):
        return self.GenPositionData()

    def GetFootprintCount(self):
        return len(self._board.GetFootprints())


class IPC356D_WRITER:
    def __init__(self, board, *_):
        self._board = board

    def Write(self, path):
        """The bare-board test netlist, record for record as pcbnew's IPC356D_WRITER writes it (export_d356.cpp)."""
        b = self._board
        copper = b._copper_layers() if hasattr(b, "_copper_layers") else [F_Cu, B_Cu]
        nlayers = max(2, len(copper))
        aux = b.GetDesignSettings().GetAuxOrigin()

        def d356(iu, cap):                      # 1/10 mil units, clamped to the field
            v = int(round(ToMils(iu) * 10))
            return max(-cap, min(cap, v))

        def access(top, bottom):
            return 0 if top and bottom else (1 if top else nlayers)

        def mask(item_top, item_bottom):
            return (1 if item_top else 0) | (2 if item_bottom else 0)

        recs = []
        for fp in b.GetFootprints():
            for pad in fp.Pads():
                top, bottom = pad.IsOnLayer(F_Cu), pad.IsOnLayer(B_Cu)
                if not top and not bottom:
                    continue
                drill = pad.GetDrillSize()
                hole = drill.x > 0 or drill.y > 0
                pos, size = pad.GetPosition(), pad.GetSize()
                net = pad.GetNetname()
                recs.append({"smd": not hole, "net": net, "ref": fp.GetReference(), "pin": str(pad.GetNumber()), "mid": False, "hole": hole,
                             "drill": min(drill.x, drill.y) if hole else 0, "pth": pad.GetAttribute() != PAD_ATTRIB_NPTH,
                             "access": access(top, bottom), "x": pos.x - aux.x, "y": aux.y - pos.y, "w": size.x, "h": size.y,
                             "rot": int(round(pad.GetOrientationDegrees())) % 360,
                             "mask": mask(pad.IsOnLayer(F_Mask), pad.IsOnLayer(B_Mask))})
        for t in b.GetTracks():
            if not isinstance(t, PCB_VIA):
                continue
            pos = t.GetPosition()
            top, bottom = t.IsOnLayer(F_Cu), t.IsOnLayer(B_Cu)
            w = t.GetWidth(F_Cu) if top or not bottom else t.GetWidth(B_Cu)
            recs.append({"smd": False, "net": t.GetNetname(), "ref": "VIA", "pin": "", "mid": True, "hole": True, "drill": t.GetDrillValue(), "pth": True,
                         "access": access(top, bottom) if (top or bottom) else 0, "x": pos.x - aux.x, "y": aux.y - pos.y, "w": w, "h": w, "rot": 0, "mask": 3})

        # Net names longer than the 14 characters a record holds get a NETnnnn alias, declared in the header.
        alias, lines = {}, ["P  CODE 00", "P  UNITS CUST 0", "P  arrayDim   N"]
        for r in recs:
            n = r["net"]
            if not n:
                r["name"] = "N/C"
            elif len(n) <= 14:
                r["name"] = n
            else:
                if n not in alias:
                    alias[n] = f"NET{len(alias) + 1}"
                    lines.append(f"P  NNAME{len(alias)} {n}")
                r["name"] = alias[n]
        for r in recs:
            line = "%03d%-14.14s   %-6.6s%c%-4.4s%c" % (327 if r["smd"] else 317, r["name"], r["ref"], "-" if r["pin"] else " ", r["pin"], "M" if r["mid"] else " ")
            line += ("D%04d%c" % (d356(r["drill"], 9999), "P" if r["pth"] else "U")) if r["hole"] else "      "
            line += "A%02dX%+07dY%+07dX%04dY%04dR%03d" % (r["access"], d356(r["x"], 999999), d356(r["y"], 999999), d356(r["w"], 9999), d356(r["h"], 9999), r["rot"])
            line += " S%d" % r["mask"]
            lines.append(line)
        lines.append("999")
        import os
        os.makedirs(os.path.dirname(str(path)) or ".", exist_ok=True)
        with open(str(path), "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        return True


class GERBER_JOBFILE_WRITER:
    def __init__(self, board, *_):
        self._board = board

    def AddGbrFile(self, *_):
        pass

    def CreateJobFile(self, path):
        _unsupported("The Gerber job file")

    def WriteJSONJobFile(self, path):
        _unsupported("The Gerber job file")


class ZONE_SETTINGS:
    """The values of the zone properties dialog, with KiCad's defaults; ExportSetting writes them into a zone."""
    SMOOTHING_UNDEFINED, SMOOTHING_NONE, SMOOTHING_CHAMFER, SMOOTHING_FILLET, SMOOTHING_LAST = -1, 0, 1, 2, 3

    def __init__(self, *_):
        self.m_ZonePriority = 0
        self.m_FillMode = ZONE_FILL_MODE_POLYGONS
        self.m_ZoneClearance = FromMM(0.508)
        self.m_ZoneMinThickness = FromMM(0.254)
        self.m_HatchThickness = 0
        self.m_HatchGap = 0
        self.m_HatchOrientation = EDA_ANGLE(0)
        self.m_HatchSmoothingLevel = 0
        self.m_HatchSmoothingValue = 0.1
        self.m_HatchHoleMinArea = 0.3
        self.m_HatchBorderAlgorithm = 1
        self.m_NetcodeSelection = 0
        self.m_Netcode = 0
        self.m_Name = ""
        self.m_Layers = LSET([F_Cu])
        self.m_ZoneBorderDisplayStyle = ZONE_BORDER_DISPLAY_STYLE_DIAGONAL_EDGE
        self.m_BorderHatchPitch = FromMM(0.5)
        self.m_ThermalReliefGap = FromMM(0.508)
        self.m_ThermalReliefSpokeWidth = FromMM(0.508)
        self.m_Locked = False
        self.m_TeardropType = 0
        self._pad_connection = ZONE_CONNECTION_THERMAL
        self._corner_smoothing = 0
        self._corner_radius = 0
        self._island_mode = ISLAND_REMOVAL_MODE_ALWAYS
        self._island_area = FromMM(10) * FromMM(1)
        self._rule_area = False
        self._keepout = {"tracks": False, "vias": False, "pads": False, "copperpour": False, "footprints": False}

    GetPadConnection = lambda self: self._pad_connection
    SetPadConnection = lambda self, v: setattr(self, "_pad_connection", v)
    GetCornerSmoothingType = lambda self: self._corner_smoothing
    SetCornerSmoothingType = lambda self, v: setattr(self, "_corner_smoothing", v)
    GetCornerRadius = lambda self: self._corner_radius
    SetCornerRadius = lambda self, v: setattr(self, "_corner_radius", v)
    GetIslandRemovalMode = lambda self: self._island_mode
    SetIslandRemovalMode = lambda self, v: setattr(self, "_island_mode", v)
    GetMinIslandArea = lambda self: self._island_area
    SetMinIslandArea = lambda self, v: setattr(self, "_island_area", v)
    GetIsRuleArea = lambda self: self._rule_area
    SetIsRuleArea = lambda self, v: setattr(self, "_rule_area", bool(v))
    GetDoNotAllowTracks = lambda self: self._keepout["tracks"]
    GetDoNotAllowVias = lambda self: self._keepout["vias"]
    GetDoNotAllowPads = lambda self: self._keepout["pads"]
    GetDoNotAllowCopperPour = lambda self: self._keepout["copperpour"]
    GetDoNotAllowFootprints = lambda self: self._keepout["footprints"]
    GetDoNotAllowZoneFills = GetDoNotAllowCopperPour
    SetDoNotAllowTracks = lambda self, v: self._keepout.__setitem__("tracks", bool(v))
    SetDoNotAllowVias = lambda self, v: self._keepout.__setitem__("vias", bool(v))
    SetDoNotAllowPads = lambda self, v: self._keepout.__setitem__("pads", bool(v))
    SetDoNotAllowCopperPour = lambda self, v: self._keepout.__setitem__("copperpour", bool(v))
    SetDoNotAllowFootprints = lambda self, v: self._keepout.__setitem__("footprints", bool(v))
    SetDoNotAllowZoneFills = SetDoNotAllowCopperPour

    def __lshift__(self, zone):
        """settings << zone: take the zone's values."""
        self.m_ZonePriority = zone.GetAssignedPriority()
        self.m_FillMode = zone.GetFillMode()
        self.m_ZoneClearance = zone.GetLocalClearance() or 0
        self.m_ZoneMinThickness = zone.GetMinThickness()
        self.m_HatchThickness, self.m_HatchGap = zone.GetHatchThickness(), zone.GetHatchGap()
        self.m_HatchOrientation = zone.GetHatchOrientation()
        self.m_NetcodeSelection = self.m_Netcode = zone.GetNetCode()
        self.m_Name = zone.GetZoneName()
        self.m_Layers = zone.GetLayerSet()
        self.m_ZoneBorderDisplayStyle = zone.GetHatchStyle()
        self.m_ThermalReliefGap, self.m_ThermalReliefSpokeWidth = zone.GetThermalReliefGap(), zone.GetThermalReliefSpokeWidth()
        self._pad_connection = zone.GetPadConnection()
        self._island_mode, self._island_area = zone.GetIslandRemovalMode(), zone.GetMinIslandArea()
        self._rule_area = zone.GetIsRuleArea()
        for what in self._keepout:
            self._keepout[what] = zone._keepout(what)
        return self

    def ExportSetting(self, zone, aFullExport=True):
        zone.SetFillMode(self.m_FillMode)
        zone.SetLocalClearance(self.m_ZoneClearance)
        zone.SetMinThickness(self.m_ZoneMinThickness)
        if self.m_FillMode == ZONE_FILL_MODE_HATCH_PATTERN:
            zone.SetHatchThickness(self.m_HatchThickness)
            zone.SetHatchGap(self.m_HatchGap)
            zone.SetHatchOrientation(self.m_HatchOrientation)
        zone.SetPadConnection(self._pad_connection)
        zone.SetThermalReliefGap(self.m_ThermalReliefGap)
        zone.SetThermalReliefSpokeWidth(self.m_ThermalReliefSpokeWidth)
        zone.SetIslandRemovalMode(self._island_mode)
        if self._island_mode == ISLAND_REMOVAL_MODE_AREA:
            zone.SetMinIslandArea(self._island_area)
        if self._rule_area or zone.GetIsRuleArea():
            zone.SetIsRuleArea(self._rule_area)
            for what, on in self._keepout.items():
                zone._set_keepout(what, on)
        if aFullExport:
            zone.SetAssignedPriority(self.m_ZonePriority)
            zone.SetLayerSet(self.m_Layers)
            zone.SetZoneName(self.m_Name)
            if not self._rule_area:
                zone.SetNetCode(self.m_Netcode or self.m_NetcodeSelection)
        zone.SetHatchStyle(self.m_ZoneBorderDisplayStyle)

    def SetupLayersList(self, *_):
        pass


class DRC_ENGINE:
    def __init__(self, *_):
        _unsupported("Running DRC from a plugin")


def WriteDRCReport(*_):
    _unsupported("Running DRC from a plugin")




def ImportSpecctraSES(*_):
    _unsupported("Specctra session import")


def ExportVRML(aFullFileName, aMMtoWRMLunit=1.0, *rest):
    """File > Export > VRML, written by the editor (web/fab/vrml.ts) in pcbnew's own layout: the placed 3D models, then
    the board body, copper, paste, solder mask, plated holes and silkscreen.  Takes KiCad 6 and 7's seven arguments
    (file, unit, export 3D files, relative paths, 3D folder, x and y reference) and KiCad 8's nine, which add "include
    unspecified" and "include DNP" after the unit."""
    import os
    if len(rest) >= 7:
        unspecified, dnp, separate, relative, subdir, xref, yref = rest[:7]
    else:
        separate, relative, subdir, xref, yref = (list(rest) + [False, False, "", 0.0, 0.0][len(rest):])[:5]
        unspecified = dnp = True
        _Host.kicad6 = True
    name, subdir = os.fspath(aFullFileName), os.fspath(subdir) if subdir else ""
    if subdir and not os.path.isabs(subdir):
        subdir = os.path.join(os.path.dirname(os.path.abspath(name)), subdir)
    import kicad_web
    kicad_web.flush()
    res = kicad_web._call("fab.vrml", {"unit": float(aMMtoWRMLunit), "separateModels": bool(separate), "relativePaths": bool(relative), "subdir": subdir,
                                       "xref": float(xref), "yref": float(yref), "includeUnspecified": bool(unspecified), "includeDnp": bool(dnp), "fileName": name})
    if not isinstance(res, dict) or not res.get("text"):
        return False
    models = res.get("models") or []
    if separate and (models or subdir):
        os.makedirs(subdir or os.path.dirname(os.path.abspath(name)), exist_ok=True)
    for m in models:
        with open(os.path.join(subdir or os.path.dirname(os.path.abspath(name)), os.path.basename(str(m.get("name")))), "w", encoding="utf-8") as fh:
            fh.write(m.get("text") or "")
    with open(name, "w", encoding="utf-8") as fh:
        fh.write(res["text"])
    missing = (res.get("stats") or {}).get("missing") or []
    if missing:
        _logging.getLogger("pcbnew").info("VRML export: %d model(s) could not be read and were left out: %s", len(missing), ", ".join(missing[:8]))
    return True


def ExportFootprintsToLibrary(*_):
    _unsupported("Exporting footprints to a library")


def WriteDRCReport(*_):
    _unsupported("The DRC report")


class PCB_IO_MGR:
    KICAD_SEXP, LEGACY, EAGLE = 1, 0, 2

    @staticmethod
    def PluginFind(kind=1, *_):
        if kind != PCB_IO_MGR.KICAD_SEXP:
            _unsupported("Footprint libraries of other programs' formats")
        return PCB_IO_KICAD_SEXPR()

    @staticmethod
    def GuessPluginTypeFromLibPath(path, *_):
        return PCB_IO_MGR.KICAD_SEXP

    FindPluginTypeFromBoardPath = GuessPluginTypeFromLibPath

    @staticmethod
    def Load(kind, path, *_):
        if kind != PCB_IO_MGR.KICAD_SEXP:
            _unsupported("Loading boards of other formats")
        return LoadBoard(path)

    @staticmethod
    def Save(kind, path, board, *_):
        if kind != PCB_IO_MGR.KICAD_SEXP:
            _unsupported("Saving boards in other formats")
        return SaveBoard(path, board)

    IO_FIND = PluginFind
    FindPlugin = PluginFind


IO_MGR = PCB_IO_MGR


def GetPluginForPath(libname):
    """The reader for a footprint library folder, as KiCad's own helper of this name gives."""
    return PCB_IO_MGR.PluginFind(PCB_IO_MGR.GuessPluginTypeFromLibPath(libname))


class PCB_IO_KICAD_SEXPR:
    def __init__(self, *_):
        pass

    def FootprintLoad(self, lib, name, *_):
        return FootprintLoad(lib, name)

    def FootprintEnumerate(self, lib, *_):
        return FootprintEnumerate(lib)

    def FootprintSave(self, *_):
        _lib_read_only()

    FootprintDelete = FootprintSave

    def Format(self, item, *_):
        return _dump(item._node)

    def Parse(self, text):
        node = _parse(str(text))[0]
        return _ITEM_CLASSES.get(str(node[0]), _OtherItem)._wrap(node, None)


PCB_PLUGIN = PCB_IO = PLUGIN = PCB_IO_KICAD_SEXPR


class STRING_FORMATTER:
    def __init__(self):
        self._s = ""

    def GetString(self):
        return self._s

    def Print(self, *a):
        self._s += " ".join(str(x) for x in a[1:] if isinstance(x, str))

    def Clear(self):
        self._s = ""


class _ItemList(list):
    """The SWIG containers (TRACKS, FOOTPRINTS, …) are plain lists here."""

    def push_back(self, x):
        self.append(x)

    def size(self):
        return len(self)

    def empty(self):
        return not self

    def front(self):
        return self[0]

    def back(self):
        return self[-1]


TRACKS = FOOTPRINTS = DRAWINGS = PADS = PADS_VEC = ZONES = GROUPS = MARKERS = PCB_FIELDS = VIA_DIMENSION_Vector = VECTOR_VECTOR2I = wxPoint_Vector = intVector = base_seqVect = LSEQ = _ItemList
PCBNEW_LAYER_ID_START = 0
PCB_LAYER_ID_COUNT_OLD = 64


def BOARD_GetStandardLayerName(layer):
    return _ui_layer_name(layer)


def LoadPluginModule(Dirname, ModuleName, FileName):
    """Import one plugin from the plugins folder, as KiCad does (plugins look for this frame on the stack)."""
    import importlib
    return importlib.import_module(ModuleName)


def LoadPlugins(*_):
    pass


class PCB_EDIT_FRAME:
    pass


class wxApp:
    pass


# Anything else a plugin names is given a placeholder: importing the plugin and running the parts
# of it that stay within what the web has must not fail because of a name another part mentions.
_missing = set()


# ----------------------------------------------------------------------------- item geometry
# What KiCad answers from its own geometry kernel (an item's copper as a polygon, whether two
# shapes are closer than a clearance, the board outline as polygons) is answered here with
# shapely (GEOS), which the runtime loads for a plugin that asks for any of it.

def _sh():
    return SHAPE_POLY_SET._shapely()


def _quad_segs(r, err=None):
    """Segments per quarter circle that keep a circle of radius r within `err` of the true one."""
    err = float(err) if isinstance(err, (int, float)) and err and err > 0 else 5000.0
    if r <= err:
        return 2
    return max(2, min(32, int(_math.ceil((_math.pi / 2) / (2 * _math.acos(1 - err / r))))))


def _arc_points(s, m, e, err=None):
    """Points along the arc through start, mid and end."""
    c = _circle3(s, m, e)
    if not c:
        return [(s.x, s.y), (e.x, e.y)]
    cx, cy, r = c
    a0, a1, a2 = (_math.atan2(p.y - cy, p.x - cx) for p in (s, m, e))
    d1, d2 = (a1 - a0) % (2 * _math.pi), (a2 - a0) % (2 * _math.pi)
    sweep = d2 if d1 <= d2 else d2 - 2 * _math.pi
    n = max(2, int(_math.ceil(abs(sweep) / (_math.pi / 2) * _quad_segs(r, err))))
    pts = [(cx + r * _math.cos(a0 + sweep * i / n), cy + r * _math.sin(a0 + sweep * i / n)) for i in range(n + 1)]
    pts[0], pts[-1] = (s.x, s.y), (e.x, e.y)
    return pts


def _bezier_points(p0, p1, p2, p3, n=24):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
                    u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y))
    return out


def _shape_path(d, err=None):
    """A graphic's centre line: (points, closed)."""
    k = d._kind()
    if k == "rect":
        return [(p.x, p.y) for p in d.GetRectCorners()], True
    if k == "circle":
        c, r = d.GetCenter(), d.GetRadius()
        n = 4 * _quad_segs(r, err)
        return [(c.x + r * _math.cos(2 * _math.pi * i / n), c.y + r * _math.sin(2 * _math.pi * i / n)) for i in range(n)], True
    if k == "arc":
        return _arc_points(d.GetStart(), d.GetArcMid(), d.GetEnd(), err), False
    if k == "poly":
        return [(p.x, p.y) for p in d._poly_points()], True
    if k in ("curve", "bezier"):
        return _bezier_points(d.GetStart(), d.GetBezierC1(), d.GetBezierC2(), d.GetEnd()), False
    s, e = d.GetStart(), d.GetEnd()
    return [(s.x, s.y), (e.x, e.y)], False


def _shape_geom(d, err=None):
    """A graphic as the copper (or ink) it puts down: the stroke, plus the inside when it is filled."""
    sh = _sh()
    G = sh.geometry
    pts, closed = _shape_path(d, err)
    w = d.GetWidth() or 0
    half = w / 2.0
    if len(pts) < 2:
        return G.Polygon()
    if not closed:
        if pts[0] == pts[-1] and len(pts) == 2:
            return G.Point(pts[0]).buffer(max(half, 1), quad_segs=_quad_segs(half, err))
        return G.LineString(pts).buffer(max(half, 1), quad_segs=_quad_segs(half, err))
    if len(pts) < 3:
        return G.LineString(pts).buffer(max(half, 1), quad_segs=_quad_segs(half, err))
    filled = d.IsFilled() or (d._kind() == "poly" and _kid(d._node, "fill") is None)
    ring = G.LinearRing(pts)
    if filled:
        g = G.Polygon(pts)
        if not g.is_valid:
            g = g.buffer(0)
        return g.buffer(half, quad_segs=_quad_segs(half, err)) if half > 0 else g
    return ring.buffer(max(half, 1), quad_segs=_quad_segs(half, err))


def _place_geom(g, rot, x, y):
    """Rotate about the origin the way `_rot` does, then move to (x, y)."""
    from shapely import affinity
    if rot:
        a = _math.radians(rot)
        c, s = _math.cos(a), _math.sin(a)
        return affinity.affine_transform(g, [c, s, -s, c, x, y])
    return affinity.translate(g, x, y)


def _pad_geom(pad, layer=None, err=None):
    sh = _sh()
    G = sh.geometry
    p, s, off = pad.GetPosition(), pad.GetSize(), pad.GetOffset()
    hx, hy = s.x / 2.0, s.y / 2.0
    shape = pad.GetShape()
    if shape == PAD_SHAPE_CIRCLE:
        g = G.Point(0, 0).buffer(hx, quad_segs=_quad_segs(hx, err))
    elif shape == PAD_SHAPE_OVAL:
        r = min(hx, hy)
        dx, dy = hx - r, hy - r
        g = (G.Point(0, 0) if dx == dy == 0 else G.LineString([(-dx, -dy), (dx, dy)])).buffer(r, quad_segs=_quad_segs(r, err))
    elif shape == PAD_SHAPE_ROUNDRECT:
        r = min(pad.GetRoundRectCornerRadius(), hx, hy)
        if r > 0 and hx > r and hy > r:
            g = G.box(-hx + r, -hy + r, hx - r, hy - r).buffer(r, quad_segs=_quad_segs(r, err))
        elif r > 0:
            g = G.LineString([(-(hx - r), -(hy - r)), (hx - r, hy - r)]).buffer(r, quad_segs=_quad_segs(r, err))
        else:
            g = G.box(-hx, -hy, hx, hy)
    elif shape == PAD_SHAPE_TRAPEZOID:
        k = _kid(pad._node, "rect_delta")
        ddy, ddx = (FromMM(_f(k[1])) / 2.0, FromMM(_f(k[2])) / 2.0) if k is not None and len(k) > 2 else (0, 0)
        g = G.Polygon([(-hx - ddx, hy + ddy), (-hx + ddx, -hy - ddy), (hx - ddx, -hy + ddy), (hx + ddx, hy - ddy)])
        if not g.is_valid:
            g = g.buffer(0)
    else:
        g = G.box(-hx, -hy, hx, hy)
        if shape == PAD_SHAPE_CUSTOM:
            anchor = _kid(_kid(pad._node, "options") or [], "anchor")
            if anchor is not None and len(anchor) > 1 and str(anchor[1]) == "circle":
                g = G.Point(0, 0).buffer(hx, quad_segs=_quad_segs(hx, err))
            parts = [g]
            for prim in (_kid(pad._node, "primitives") or [])[1:]:
                if not isinstance(prim, list) or not prim:
                    continue
                kind = str(prim[0])
                wk = _kid(prim, "width")
                half = FromMM(_f(wk[1])) / 2.0 if wk is not None and len(wk) > 1 else 0
                xy = lambda name: (lambda q: (FromMM(_f(q[1])), FromMM(_f(q[2]))) if q is not None and len(q) > 2 else None)(_kid(prim, name))
                if kind == "gr_poly":
                    pp = [(FromMM(_f(q[1])), FromMM(_f(q[2]))) for q in (_kid(prim, "pts") or [])[1:] if isinstance(q, list) and len(q) > 2]
                    if len(pp) >= 3:
                        q = G.Polygon(pp)
                        q = q if q.is_valid else q.buffer(0)
                        parts.append(q.buffer(half) if half > 0 else q)
                elif kind == "gr_line" and xy("start") and xy("end"):
                    parts.append(G.LineString([xy("start"), xy("end")]).buffer(max(half, 1)))
                elif kind == "gr_circle" and xy("center") and xy("end"):
                    c, e = xy("center"), xy("end")
                    rr = _math.hypot(e[0] - c[0], e[1] - c[1])
                    fk = _kid(prim, "fill")
                    solid = fk is not None and len(fk) > 1 and str(fk[1]) not in ("none", "no")
                    parts.append(G.Point(c).buffer(rr + half) if solid or half == 0 else G.Point(c).buffer(rr).exterior.buffer(half))
                elif kind == "gr_rect" and xy("start") and xy("end"):
                    a, b = xy("start"), xy("end")
                    parts.append(G.box(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])))
                elif kind == "gr_arc" and xy("start") and xy("mid") and xy("end"):
                    parts.append(G.LineString(_arc_points(VECTOR2I(*xy("start")), VECTOR2I(*xy("mid")), VECTOR2I(*xy("end")), err)).buffer(max(half, 1)))
            g = sh.unary_union(parts)
    if off.x or off.y:
        from shapely import affinity
        g = affinity.translate(g, off.x, off.y)
    return _place_geom(g, pad.GetOrientation().AsDegrees(), p.x, p.y)


def _track_geom(t, err=None):
    G = _sh().geometry
    half = t.GetWidth() / 2.0
    if isinstance(t, PCB_VIA):
        p = t.GetPosition()
        return G.Point(p.x, p.y).buffer(half, quad_segs=_quad_segs(half, err))
    if isinstance(t, PCB_ARC):
        pts = _arc_points(t.GetStart(), t.GetMid(), t.GetEnd(), err)
    else:
        s, e = t.GetStart(), t.GetEnd()
        pts = [(s.x, s.y), (e.x, e.y)]
    if len(pts) == 2 and pts[0] == pts[1]:
        return G.Point(pts[0]).buffer(max(half, 1), quad_segs=_quad_segs(half, err))
    return G.LineString(pts).buffer(max(half, 1), quad_segs=_quad_segs(half, err))


def _item_geom(item, layer=None, err=None):
    """The copper (or ink) of one board item as a shapely geometry; kept until the item changes."""
    d = item.__dict__
    par = getattr(item, "_parent", None)
    key = (d.get("_rev", 0), par.__dict__.get("_rev", 0) if par is not None else 0, id(item._node),
           int(layer) if isinstance(item, ZONE) and layer is not None else None, err)
    hit = d.get("_geomc")
    if hit is not None and hit[0] == key:
        return hit[1]
    if isinstance(item, PAD):
        g = _pad_geom(item, layer, err)
    elif isinstance(item, PCB_TRACK):
        g = _track_geom(item, err)
    elif isinstance(item, ZONE):
        if layer is None:
            g = _sh().unary_union([item.GetFilledPolysList(l)._geom() for l in item.GetLayerSet().Seq()])
        else:
            g = item.GetFilledPolysList(layer)._geom()
    elif isinstance(item, PCB_SHAPE):
        g = _shape_geom(item, err)
    elif isinstance(item, FOOTPRINT):
        g = _sh().unary_union([_pad_geom(p, layer, err) for p in item.Pads()])
    else:
        b = item.GetBoundingBox()
        g = _sh().geometry.box(b.GetLeft(), b.GetTop(), b.GetRight(), b.GetBottom())
    d["_geomc"] = (key, g)
    return g


def _geom_of(x):
    """Anything KiCad would take as a shape, as a shapely geometry."""
    if isinstance(x, SHAPE):
        return x._g
    if isinstance(x, SHAPE_POLY_SET):
        return x._geom()
    if isinstance(x, SHAPE_LINE_CHAIN):
        key = (id(x._pts), len(x._pts), x.IsClosed())
        hit = x.__dict__.get("_gc")
        if hit is not None and hit[0] == key:
            return hit[1]
        G = _sh().geometry
        pts = [(p.x, p.y) for p in x._pts]
        if len(pts) == 1:
            g = G.Point(pts[0])
        elif x.IsClosed() and len(pts) >= 3:
            g = G.Polygon(pts)
            g = g if g.is_valid else g.buffer(0)
        else:
            g = G.LineString(pts) if len(pts) > 1 else G.Polygon()
        try:
            _sh().prepare(g)
        except Exception:
            pass
        x.__dict__["_gc"] = (key, g)
        return g
    if isinstance(x, BOX2I):
        return _sh().geometry.box(x.GetLeft(), x.GetTop(), x.GetRight(), x.GetBottom())
    if isinstance(x, BOARD_ITEM):
        return _item_geom(x)
    p = VECTOR2I(x)
    return _sh().geometry.Point(p.x, p.y)


def _collide(a, b, clearance=0):
    """KiCad's rule: two shapes collide when they touch, or are closer than the clearance."""
    if a.is_empty or b.is_empty:
        return False
    clearance = float(clearance or 0)
    if clearance <= 0:
        return bool(a.intersects(b))
    sh = _sh()
    near = getattr(sh, "dwithin", None)
    if near is not None:
        try:
            return bool(near(a, b, clearance)) and (bool(a.intersects(b)) or a.distance(b) < clearance)
        except Exception:
            pass
    return bool(a.intersects(b)) or a.distance(b) < clearance


class SHAPE:
    """A geometric shape (KiCad's SHAPE): what `GetEffectiveShape` returns and what `Collide` takes."""

    def __init__(self, geom=None):
        self._g = geom if geom is not None else _sh().geometry.Polygon()

    def Collide(self, other, clearance=0, *_):
        return _collide(self._g, _geom_of(other), clearance if isinstance(clearance, (int, float)) else 0)

    def BBox(self, clearance=0, *_):
        if self._g.is_empty:
            return BOX2I()
        x0, y0, x1, y1 = self._g.bounds
        c = int(clearance or 0)
        return BOX2I._of(int(x0) - c, int(y0) - c, int(x1) + c, int(y1) + c)

    def Centre(self):
        c = self._g.centroid if not self._g.is_empty else None
        return VECTOR2I(int(round(c.x)), int(round(c.y))) if c is not None else VECTOR2I(0, 0)

    def Move(self, d):
        from shapely import affinity
        d = VECTOR2I(d)
        self._g = affinity.translate(self._g, d.x, d.y)

    def Rotate(self, angle, centre=(0, 0)):
        c = VECTOR2I(centre)
        from shapely import affinity
        self._g = affinity.translate(_place_geom(affinity.translate(self._g, -c.x, -c.y), _deg(angle), 0, 0), c.x, c.y)

    def IsSolid(self):
        return True

    def Area(self):
        return float(self._g.area)

    def GetClearance(self, other):
        return int(self._g.distance(_geom_of(other)))

    def PointInside(self, point, accuracy=0, *_):
        p = VECTOR2I(point)
        return _collide(self._g, _sh().geometry.Point(p.x, p.y), accuracy)

    def TransformToPolygon(self, polyset, maxError=None, errorLoc=None):
        polyset._add_geom(self._g)

    def GetSubshapes(self):
        return [SHAPE(g) for g in getattr(self._g, "geoms", [self._g])]

    Shapes = GetSubshapes

    def Size(self):
        return len(self.GetSubshapes())


SHAPE_COMPOUND = SHAPE
SHAPE_SIMPLE = SHAPE


class SHAPE_CIRCLE(SHAPE):
    def __init__(self, *a):
        if len(a) >= 2 and not isinstance(a[0], (int, float)):
            c, r = VECTOR2I(a[0]), a[1]
        elif len(a) >= 3:
            c, r = VECTOR2I(a[0], a[1]), a[2]
        else:
            c, r = VECTOR2I(0, 0), 0
        self._c, self._r = c, int(r)
        self._make()

    def _make(self):
        G = _sh().geometry
        self._g = G.Point(self._c.x, self._c.y).buffer(self._r, quad_segs=_quad_segs(self._r, 2000)) if self._r > 0 else G.Point(self._c.x, self._c.y)

    def Collide(self, other, clearance=0, *_):
        # exact against the true circle, not its polygon
        o = _geom_of(other)
        if o.is_empty:
            return False
        centre = _sh().geometry.Point(self._c.x, self._c.y)
        gap = centre.distance(o) - self._r
        c = clearance if isinstance(clearance, (int, float)) else 0
        return gap <= 0 or gap < c

    def GetCenter(self):
        return VECTOR2I(self._c)

    Centre = GetCenter

    def GetRadius(self):
        return self._r

    def SetRadius(self, r):
        self._r = int(r)
        self._make()

    def SetCenter(self, c):
        self._c = VECTOR2I(c)
        self._make()

    def Move(self, d):
        self._c = self._c + VECTOR2I(d)
        self._make()


class SEG:
    def __init__(self, a=(0, 0), b=(0, 0), *more):
        if more:
            a, b = (a, b), more[:2]
        self.A, self.B = VECTOR2I(a), VECTOR2I(b)

    def Length(self):
        return int(self.A.Distance(self.B))

    def Center(self):
        return VECTOR2I((self.A.x + self.B.x) // 2, (self.A.y + self.B.y) // 2)

    def Distance(self, other):
        G = _sh().geometry
        me = G.LineString([(self.A.x, self.A.y), (self.B.x, self.B.y)])
        return int(me.distance(_geom_of(other) if not isinstance(other, SEG) else G.LineString([(other.A.x, other.A.y), (other.B.x, other.B.y)])))


class SHAPE_SEGMENT(SHAPE):
    def __init__(self, a=None, b=None, width=0):
        if isinstance(a, SEG):
            a, b, width = a.A, a.B, (b or 0)
        self._a, self._b, self._w = VECTOR2I(a or (0, 0)), VECTOR2I(b or (0, 0)), int(width or 0)
        G = _sh().geometry
        line = G.LineString([(self._a.x, self._a.y), (self._b.x, self._b.y)]) if self._a != self._b else G.Point(self._a.x, self._a.y)
        self._g = line.buffer(self._w / 2.0, quad_segs=_quad_segs(self._w / 2.0, 2000)) if self._w > 0 else line

    def GetSeg(self):
        return SEG(self._a, self._b)

    def GetWidth(self):
        return self._w


class SHAPE_RECT(SHAPE):
    def __init__(self, *a):
        if len(a) == 1 and isinstance(a[0], BOX2I):
            x, y, w, h = a[0].GetX(), a[0].GetY(), a[0].GetWidth(), a[0].GetHeight()
        elif len(a) >= 3 and not isinstance(a[0], (int, float)):
            p = VECTOR2I(a[0])
            x, y, w, h = p.x, p.y, a[1], a[2]
        elif len(a) >= 4:
            x, y, w, h = a[:4]
        else:
            x = y = w = h = 0
        self._x, self._y, self._w, self._h = int(x), int(y), int(w), int(h)
        self._g = _sh().geometry.box(self._x, self._y, self._x + self._w, self._y + self._h)

    def GetPosition(self):
        return VECTOR2I(self._x, self._y)

    def GetSize(self):
        return VECTOR2I(self._w, self._h)

    def GetWidth(self):
        return self._w

    def GetHeight(self):
        return self._h


def _poly_add_geom(self, g):
    """Append a shapely geometry's polygons as outlines (no merging, as KiCad's transforms do)."""
    parts = [g] if g.geom_type == "Polygon" else [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]
    for part in parts:
        if part.is_empty:
            continue
        chain = lambda ring: SHAPE_LINE_CHAIN([VECTOR2I(int(round(x)), int(round(y))) for x, y in list(ring.coords)[:-1]], True)
        self._outlines.append([chain(part.exterior)] + [chain(r) for r in part.interiors])


def _poly_geom_cached(self):
    key = hash(tuple((len(o), tuple((p.x, p.y) for c in o for p in c._pts)) for o in self._outlines))
    hit = self.__dict__.get("_gc")
    if hit is not None and hit[0] == key:
        return hit[1]
    g = _poly_geom_raw(self)
    try:
        _sh().prepare(g)
    except Exception:
        pass
    self.__dict__["_gc"] = (key, g)
    return g


def _poly_collide(self, *a):
    if not a:
        return False
    other = a[0]
    clearance = a[1] if len(a) > 1 and isinstance(a[1], (int, float)) else 0
    try:
        import shapely          # noqa: F401
    except ImportError:
        return self.Contains(other) if not isinstance(other, (SHAPE, SHAPE_POLY_SET)) else False
    return _collide(self._geom(), _geom_of(other), clearance)


def _poly_contains(self, point, subpolyIndex=-1, accuracy=0, *_):
    hit = self.__dict__.get("_gc")
    if hit is None and self.TotalVertices() < 400:
        return _poly_contains_plain(self, point)
    try:
        import shapely          # noqa: F401
    except ImportError:
        return _poly_contains_plain(self, point)
    p = VECTOR2I(point)
    return _collide(self._geom(), _sh().geometry.Point(p.x, p.y), accuracy if isinstance(accuracy, (int, float)) else 0)


def _chain_collide(self, other, clearance=0, *_):
    return _collide(_geom_of(self), _geom_of(other), clearance if isinstance(clearance, (int, float)) else 0)


SHAPE_LINE_CHAIN.Collide = _chain_collide
_poly_geom_raw = SHAPE_POLY_SET._geom
_poly_contains_plain = SHAPE_POLY_SET.Contains
SHAPE_POLY_SET._geom = _poly_geom_cached
SHAPE_POLY_SET._add_geom = _poly_add_geom
SHAPE_POLY_SET.Collide = _poly_collide
SHAPE_POLY_SET.Contains = _poly_contains


def _transform_to_polygon(self, polyset, *a):
    """TransformShapeToPolygon( buffer, layer, clearance, maxError, errorLoc ): this item's shape,
    grown by the clearance, added to the buffer."""
    nums = [x for x in a if isinstance(x, (int, float)) and not isinstance(x, bool)]
    layer = nums[0] if len(nums) > 0 else None
    clearance = nums[1] if len(nums) > 1 else 0
    err = nums[2] if len(nums) > 2 else None
    if isinstance(self, (PAD, PCB_VIA, ZONE)) and layer is not None and layer >= 0 and not self.IsOnLayer(int(layer)):
        return
    g = _item_geom(self, layer, err)
    if clearance:
        g = g.buffer(clearance, quad_segs=_quad_segs(abs(clearance), err))
    polyset._add_geom(g)


def _effective_shape(self, layer=None, *_):
    return SHAPE(_item_geom(self, layer if isinstance(layer, (int, float)) and layer >= 0 else None))


def _via_shape(self, layer=None, *_):
    p = self.GetPosition()
    return SHAPE_CIRCLE(p, self.GetWidth() // 2)


def _pad_polygon(self, *a):
    out = SHAPE_POLY_SET()
    try:
        out._add_geom(_pad_geom(self, None, 2000))
    except WebUnsupported:
        return _pad_polygon_plain(self)
    return out


def _own_clearance(self, *_):
    local = self.GetLocalClearance() if hasattr(self, "GetLocalClearance") else 0
    if local:
        return int(local)
    try:
        return int(self.GetNetClass().GetClearance())
    except Exception:
        return FromMM(0.2)


def _outline_polys(shapes, err=None):
    """Closed outlines drawn with lines, arcs, rectangles, circles and polygons, as polygons;
    an outline inside another is a hole (and one inside that is solid again)."""
    sh = _sh()
    G = sh.geometry
    rings, lines = [], []
    for d in shapes:
        pts, closed = _shape_path(d, err)
        pts = [(int(round(x)), int(round(y))) for x, y in pts]
        if closed and len(pts) >= 3:
            rings.append(pts + [pts[0]])
        elif len(pts) >= 2 and pts[0] != pts[-1]:
            lines.append(pts)
    faces = []
    for tol in (0, 1000, 10000):          # outlines drawn a hair apart still close, as in KiCad
        work = [list(l) for l in lines]
        if tol:
            ends = []
            for l in work:
                for i in (0, -1):
                    for q in ends:
                        if abs(q[0] - l[i][0]) <= tol and abs(q[1] - l[i][1]) <= tol:
                            l[i] = q
                            break
                    else:
                        ends.append(l[i])
        geoms = [G.LineString(l) for l in work if l[0] != l[-1] or len(l) > 2] + [G.LineString(r) for r in rings]
        if not geoms:
            return []
        faces = list(sh.polygonize([sh.unary_union(geoms)]).geoms) if hasattr(sh, "polygonize") else []
        if faces and (not lines or len(faces) > len(rings) or not rings):
            break
    hulls = [G.Polygon(f.exterior) for f in faces]
    out = []
    for i, f in enumerate(faces):
        p = f.representative_point()
        depth = sum(1 for j, h in enumerate(hulls) if j != i and h.contains(p))
        if depth % 2 == 0:
            out.append(f)
    return out


def _board_outlines(self, outlines, *_):
    """GetBoardPolygonOutlines: the Edge.Cuts drawing as polygons with their cutouts."""
    edge = [d for d in self.GetDrawings() if isinstance(d, PCB_SHAPE) and d.GetLayer() == Edge_Cuts]
    for fp in self.GetFootprints():
        edge += [d for d in fp.GraphicalItems() if isinstance(d, PCB_SHAPE) and d.GetLayer() == Edge_Cuts]
    polys = _outline_polys(edge)
    outlines.RemoveAllContours()
    for g in polys:
        outlines._add_geom(g)
    return bool(polys)


def _courtyard(self, layer):
    shapes = [s for s in self._kids()["shapes"] if s.GetLayer() == int(layer)]
    out = SHAPE_POLY_SET()
    if not shapes:
        return out
    try:
        for g in _outline_polys(shapes):
            out._add_geom(g)
    except WebUnsupported:
        return _courtyard_plain(self, layer)
    return out


def _bump_rev(self):
    self.__dict__["_rev"] = self.__dict__.get("_rev", 0) + 1
    top = getattr(self, "_parent", None)
    if top is not None:
        top.__dict__["_rev"] = top.__dict__.get("_rev", 0) + 1
    _item_touch_plain(self)


def _hole_shape(self, *_):
    """The drilled hole as a shape: a segment as wide as the drill (a point-long one for a round hole)."""
    d = self.GetDrillSize() if isinstance(self, PAD) else VECTOR2I(self.GetDrillValue(), self.GetDrillValue())
    p = self.GetPosition()
    if d.x <= 0 and d.y <= 0:
        return SHAPE_SEGMENT(p, p, 0)
    w = min(d.x, d.y) if d.x > 0 and d.y > 0 else max(d.x, d.y)
    half = (max(d.x, d.y) - w) / 2.0
    if half <= 0:
        return SHAPE_SEGMENT(p, p, w)
    ax = (half, 0) if d.x >= d.y else (0, half)
    rot = self.GetOrientation().AsDegrees() if isinstance(self, PAD) else 0
    dx, dy = _rot(ax[0], ax[1], rot)
    return SHAPE_SEGMENT(VECTOR2I(int(round(p.x - dx)), int(round(p.y - dy))), VECTOR2I(int(round(p.x + dx)), int(round(p.y + dy))), w)


def _flash_layer(self, layer, *_):
    """Whether the pad or via has its copper ring on this layer.  With "remove unused layers" set, an inner layer
    (and an outer one too, unless the end layers are kept) only has it where something of the same net connects."""
    if isinstance(layer, LSET):
        return any(_flash_layer(self, l) for l in layer.Seq())
    layer = int(layer)
    if not self.IsOnLayer(layer):
        return False
    if not IsCopperLayer(layer):
        return True
    node = self._node
    if not _flag(node, "remove_unused_layers") and _kid(node, "remove_unused_layers") is None:
        return True
    rk = _kid(node, "remove_unused_layers")
    if rk is not None and len(rk) > 1 and str(rk[1]) in ("no", "false"):
        return True
    kk = _kid(node, "keep_end_layers")
    keep_ends = _flag(node, "keep_end_layers") or (kk is not None and not (len(kk) > 1 and str(kk[1]) in ("no", "false")))
    if keep_ends and layer in (F_Cu, B_Cu):
        return True
    b = self._board
    if b is None:
        return True
    net, pos = self.GetNetCode(), self.GetPosition()
    for t in b.GetTracks():
        if t is self or t.GetNetCode() != net or isinstance(t, PCB_VIA) or t.GetLayer() != layer:
            continue
        if t.GetStart() == pos or t.GetEnd() == pos:
            return True
    for z in b.Zones():
        if not z.GetIsRuleArea() and z.GetNetCode() == net and z.IsOnLayer(layer) and z.Outline().Contains(pos):
            return True
    return False


PAD.GetEffectiveHoleShape = _hole_shape
PCB_VIA.GetEffectiveHoleShape = _hole_shape
PAD.FlashLayer = _flash_layer
PCB_VIA.FlashLayer = _flash_layer
ZONE.HasFilledPolysForLayer = lambda self, layer: any(
    (_kid(fp, "layer") is None or _layer_id(_kid(fp, "layer")[1]) == int(layer)) for fp in _kids(self._node, "filled_polygon"))
_item_touch_plain = BOARD_ITEM._touch
BOARD_ITEM._touch = _bump_rev
_pad_polygon_plain = PAD.GetEffectivePolygon
_courtyard_plain = FOOTPRINT.GetCourtyard
PAD.GetEffectivePolygon = _pad_polygon
FOOTPRINT.GetCourtyard = _courtyard
BOARD.GetBoardPolygonOutlines = _board_outlines
BOARD_CONNECTED_ITEM.GetOwnClearance = _own_clearance
for _cls in (PAD, PCB_TRACK, PCB_SHAPE, ZONE):
    _cls.TransformShapeToPolygon = _transform_to_polygon
    _cls.TransformShapeWithClearanceToPolygon = _transform_to_polygon
    _cls.GetEffectiveShape = _effective_shape
PCB_VIA.GetEffectiveShape = _via_shape
del _cls


# ----------------------------------------------------------------------------- zone filling

def _fracture(poly):
    """One closed outline for a polygon with holes: each hole is joined to the outline on its left
    by a zero-width bridge, which is how KiCad stores a zone's filled islands."""
    from shapely.geometry.polygon import orient
    poly = orient(poly, 1.0)
    ring = [(int(round(x)), int(round(y))) for x, y in list(poly.exterior.coords)[:-1]]
    holes = [[(int(round(x)), int(round(y))) for x, y in list(r.coords)[:-1]] for r in poly.interiors]
    holes = [h for h in holes if len(h) >= 3]
    if not holes:
        return ring
    try:
        import numpy as np
    except ImportError:
        np = None
    holes.sort(key=lambda h: min(h))
    for h in holes:
        k = min(range(len(h)), key=lambda i: h[i])
        hx, hy = h[k]
        best, at = None, -1
        if np is not None:
            a = np.asarray(ring, dtype=np.float64)
            b = np.roll(a, -1, axis=0)
            ay, by = a[:, 1], b[:, 1]
            m = ((ay <= hy) & (by > hy)) | ((by <= hy) & (ay > hy))
            idx = np.nonzero(m)[0]
            if len(idx):
                x = a[idx, 0] + (hy - ay[idx]) * (b[idx, 0] - a[idx, 0]) / (by[idx] - ay[idx])
                ok = x <= hx
                if ok.any():
                    j = int(np.argmax(np.where(ok, x, -np.inf)))
                    best, at = float(x[j]), int(idx[j])
        else:
            n = len(ring)
            for i in range(n):
                (ax, ay), (bx, by) = ring[i], ring[(i + 1) % n]
                if (ay <= hy < by) or (by <= hy < ay):
                    x = ax + (hy - ay) * (bx - ax) / (by - ay)
                    if x <= hx and (best is None or x > best):
                        best, at = x, i
        if best is None:
            continue
        p = (int(round(best)), hy)
        loop = h[k:] + h[:k]
        ring = ring[:at + 1] + [p] + loop + [loop[0], p] + ring[at + 1:]
    return ring


class ZONE_FILLER:
    """Fills zones the way KiCad does: the outline, less the clearance around other nets' copper,
    with thermal reliefs, the minimum width and island removal. It works when the geometry package
    (shapely) is loaded; otherwise a refill is only requested from the desktop application.
    Either way the desktop refills with its own filler the next time zones are filled there."""

    def __init__(self, board, *_):
        self._board = board
        self._grown = {}
        self._done = {}

    def SetProgressReporter(self, *_):
        pass

    def IsDebug(self):
        return False

    def InstallNewProgressReporter(self, *_):
        pass

    def Fill(self, zones, check=False, *_):
        b = self._board
        try:
            import shapely          # noqa: F401
        except ImportError:
            b._wants_refill = True
            return True
        if b._wants_refill is not True:
            b._wants_refill = "filled"
        zones = [z for z in (list(zones) if not isinstance(zones, ZONE) else [zones]) if isinstance(z, ZONE) and not z.GetIsRuleArea()]
        if not zones:
            return True
        scene = self._scene()
        # higher priority first: a lower one keeps clear of what the higher ones filled
        for z in sorted(zones, key=lambda z: -z.GetAssignedPriority()):
            self._fill_zone(z, scene)
        return True

    # -- what is on the board, per copper layer
    def _scene(self):
        b = self._board
        sh = _sh()
        edge = SHAPE_POLY_SET()
        outline = None
        if b.GetBoardPolygonOutlines(edge):
            outline = edge._geom()
        tracks = list(b.GetTracks())
        pads = [p for fp in b.GetFootprints() for p in fp.Pads()]
        gfx = [d for d in b.GetDrawings() if isinstance(d, PCB_SHAPE) and IsCopperLayer(d.GetLayer())]
        for fp in b.GetFootprints():
            gfx += [d for d in fp.GraphicalItems() if isinstance(d, PCB_SHAPE) and IsCopperLayer(d.GetLayer())]
        zones = list(b.Zones())
        ds = b.GetDesignSettings()
        return {"sh": sh, "outline": outline, "tracks": tracks, "pads": pads, "gfx": gfx, "zones": zones,
                "min": int(ds.m_MinClearance), "edge": int(ds.m_CopperEdgeClearance),
                "hole": int(getattr(ds, "m_HoleClearance", 0) or 0)}

    def _grow(self, item, amount, layer=None):
        g = _item_geom(item, layer)
        key = (id(item), int(amount))
        hit = self._grown.get(key)
        if hit is None or hit[0] is not g:
            hit = (g, g.buffer(amount, quad_segs=_quad_segs(amount, 5000)) if amount > 0 else g)
            self._grown[key] = hit
        return hit[1]

    def _fill_zone(self, z, scene):
        sh = scene["sh"]
        G = sh.geometry
        net = z.GetNetCode()
        zclr = max(int(z.GetLocalClearance() or 0), scene["min"])
        half = z.GetMinThickness() / 2.0
        body = z.Outline()._geom()
        if body.is_empty:
            return
        box = body.bounds
        near = lambda g: not g.is_empty and not (g.bounds[2] < box[0] - reach or g.bounds[0] > box[2] + reach or g.bounds[3] < box[1] - reach or g.bounds[1] > box[3] + reach)
        connection = z.GetPadConnection()
        gap, spoke_w = z.GetThermalReliefGap(), z.GetThermalReliefSpokeWidth()
        reach = zclr + gap + FromMM(2)
        layers = [l for l in z.GetLayerSet().Seq() if IsCopperLayer(l)]
        z._node[:] = [c for c in z._node if not (isinstance(c, list) and c and c[0] in ("filled_polygon", "fill_segments"))]
        for L in layers:
            area = body
            if scene["outline"] is not None:
                area = area.intersection(scene["outline"].buffer(-scene["edge"]) if scene["edge"] > 0 else scene["outline"])
            holes, spokes, anchors, foreign = [], [], [], []
            for t in scene["tracks"]:
                if not t.IsOnLayer(L):
                    continue
                if net and t.GetNetCode() == net:
                    anchors.append(t)
                    continue
                g = self._grow(t, max(zclr, t.GetOwnClearance(L)))
                if near(g):
                    holes.append(g)
                    foreign.append(g)
            for p in scene["pads"]:
                on = p.IsOnLayer(L)
                drill = p.GetDrillSize()
                if not on:
                    # a hole goes through every layer, with or without copper around it
                    if drill.x > 0 and near(G.Point(p.GetPosition().x, p.GetPosition().y)):
                        pos = p.GetPosition()
                        holes.append(G.Point(pos.x, pos.y).buffer(max(drill.x, drill.y) / 2.0 + max(zclr, scene["hole"])))
                    continue
                same = bool(net) and p.GetNetCode() == net
                if not same:
                    g = self._grow(p, max(zclr, p.GetLocalClearance() or 0))
                    if near(g):
                        holes.append(g)
                        foreign.append(g)
                    continue
                anchors.append(p)
                how = p.GetZoneConnection()
                how = connection if how == ZONE_CONNECTION_INHERITED else how
                if how == ZONE_CONNECTION_THT_THERMAL:
                    how = ZONE_CONNECTION_THERMAL if drill.x > 0 else ZONE_CONNECTION_FULL
                if how == ZONE_CONNECTION_FULL:
                    continue
                pg = _item_geom(p, L)
                if not near(pg):
                    continue
                if how == ZONE_CONNECTION_NONE:
                    holes.append(self._grow(p, zclr))
                    continue
                pgap = p.GetThermalGap() or gap
                pw = p.GetThermalSpokeWidth() or spoke_w
                holes.append(self._grow(p, pgap))
                # four spokes along the pad's own axes (at 45 degrees for a round pad, as KiCad draws them)
                pos, size = p.GetPosition(), p.GetSize()
                rot = p.GetOrientation().AsDegrees() + (45 if p.GetShape() == PAD_SHAPE_CIRCLE else 0)
                for k in range(4):
                    ext = (size.x if k % 2 == 0 else size.y) / 2.0 + pgap + half + pw / 2.0
                    dx, dy = _rot(ext if k == 0 else -ext if k == 2 else 0, ext if k == 1 else -ext if k == 3 else 0, rot)
                    spokes.append(G.LineString([(pos.x, pos.y), (pos.x + dx, pos.y + dy)]).buffer(pw / 2.0, cap_style="flat"))
            for d in scene["gfx"]:
                if d.GetLayer() != L:
                    continue
                dn = d.GetNetCode() if hasattr(d, "GetNetCode") else 0
                if net and dn == net:
                    anchors.append(d)
                    continue
                g = self._grow(d, zclr)
                if near(g):
                    holes.append(g)
                    foreign.append(g)
            for o in scene["zones"]:
                if o is z or not o.IsOnLayer(L):
                    continue
                if o.GetIsRuleArea():
                    if o._keepout("copperpour"):
                        holes.append(o.Outline()._geom())
                    continue
                if o.GetNetCode() == net:
                    continue
                if o.GetAssignedPriority() > z.GetAssignedPriority():
                    og = o.Outline()._geom()
                    if near(og):
                        holes.append(og.buffer(max(zclr, int(o.GetLocalClearance() or 0))))
                elif o.GetAssignedPriority() == z.GetAssignedPriority():
                    og = self._done.get((id(o), L))
                    if og is None and o.IsFilled():
                        og = o.GetFilledPolysList(L)._geom()
                    if og is not None and near(og):
                        holes.append(og.buffer(max(zclr, int(o.GetLocalClearance() or 0))))
            cut = sh.unary_union(holes) if holes else G.Polygon()
            solid = area.difference(cut)
            if half > 0:
                # shrink and grow by half the minimum width: no neck narrower than the minimum is left
                solid = solid.buffer(-half).buffer(half)
            if spokes:
                arms = sh.unary_union(spokes).intersection(area)
                if foreign:
                    arms = arms.difference(sh.unary_union(foreign))
                solid = sh.unary_union([solid, arms])
            solid = solid.intersection(area)
            if z.GetFillMode() == ZONE_FILL_MODE_HATCH_PATTERN:
                solid = self._hatch(z, solid, G, sh)
            parts = [solid] if solid.geom_type == "Polygon" else [p for p in getattr(solid, "geoms", []) if p.geom_type == "Polygon"]
            parts = [p for p in parts if not p.is_empty and p.area > 0]
            mode = z.GetIslandRemovalMode()
            if net and mode != ISLAND_REMOVAL_MODE_NEVER and parts:
                touch = [_item_geom(a, L) for a in anchors]
                tree = sh.STRtree(touch) if touch else None
                kept = []
                for p in parts:
                    joined = tree is not None and len(tree.query(p, predicate="intersects")) > 0
                    if joined or (mode == ISLAND_REMOVAL_MODE_AREA and p.area >= float(z.GetMinIslandArea()) * 1.0):
                        kept.append(p)
                parts = kept
            for p in parts:
                pts = [Sym("pts")]
                for x, y in _fracture(p):
                    lx, ly = z._to_local(ToMM(x), ToMM(y))
                    pts.append([Sym("xy"), _n(lx), _n(ly)])
                z._node.append([Sym("filled_polygon"), [Sym("layer"), _layer_name(L)], pts])
            self._done[(id(z), L)] = sh.unary_union(parts) if parts else G.Polygon()
        f = z._fill(True)
        if not any(isinstance(c, Sym) and c == "yes" for c in f[1:]):
            f.insert(1, Sym("yes"))
        z._touch()

    def _hatch(self, z, solid, G, sh):
        """A hatched fill: square holes of the hatch gap, a hatch thickness apart, turned by the hatch angle."""
        thick, gap = z.GetHatchThickness(), z.GetHatchGap()
        if gap <= 0 or solid.is_empty:
            return solid
        from shapely import affinity
        angle = z.GetHatchOrientation().AsDegrees() if hasattr(z.GetHatchOrientation(), "AsDegrees") else float(z.GetHatchOrientation() or 0)
        c = solid.centroid
        flat = affinity.rotate(solid, angle, origin=c)
        x0, y0, x1, y1 = flat.bounds
        step = thick + gap
        cells = []
        y = y0 - step
        while y < y1 + step:
            x = x0 - step
            while x < x1 + step:
                cells.append(G.box(x, y, x + gap, y + gap))
                x += step
            y += step
        holes = affinity.rotate(sh.unary_union(cells), -angle, origin=c)
        inner = solid.buffer(-thick) if thick > 0 else solid          # a solid border, one hatch line wide
        holes = holes.intersection(inner)
        whole = [h for h in (getattr(holes, "geoms", [holes])) if h.geom_type == "Polygon" and h.area >= 0.3 * gap * gap]
        return solid.difference(sh.unary_union(whole)) if whole else solid


# ----------------------------------------------------------------------------- Specctra DSN export

def _dsn_q(s):
    s = str(s)
    return '"%s"' % s.replace('"', "'") if (not s or any(c in s for c in ' ()"\t')) else s


def _dsn_um(v):
    v = v / 1000.0
    return ("%.1f" % v).rstrip("0").rstrip(".") if v != int(v) else str(int(v))


def _dsn_padstack(pad, layers):
    """(name, lines) of the padstack of one pad, the way KiCad names them."""
    s = pad.GetSize()
    on = [l for l in layers if pad.IsOnLayer(l)]
    side = "A" if len(on) > 1 else ("T" if on and on[0] == F_Cu else "B")
    shape = pad.GetShape()
    w, h = _dsn_um(s.x), _dsn_um(s.y)
    if shape == PAD_SHAPE_CIRCLE:
        name, body = "Round[%s]Pad_%s_um" % (side, w), "(circle %%s %s)" % w
    elif shape == PAD_SHAPE_OVAL:
        r = min(s.x, s.y)
        dx, dy = (s.x - r) / 2.0, (s.y - r) / 2.0
        name = "Oval[%s]Pad_%sx%s_um" % (side, w, h)
        body = "(path %%s %s  %s %s  %s %s)" % (_dsn_um(r), _dsn_um(-dx), _dsn_um(-dy), _dsn_um(dx), _dsn_um(dy))
    elif shape == PAD_SHAPE_ROUNDRECT:
        name = "RoundRect[%s]Pad_%sx%s_%s_um" % (side, w, h, _dsn_um(pad.GetRoundRectCornerRadius()))
        g = _pad_local_ring(pad)
        body = "(polygon %%s 0  %s)" % "  ".join("%s %s" % (_dsn_um(x), _dsn_um(-y)) for x, y in g)
    elif shape in (PAD_SHAPE_TRAPEZOID, PAD_SHAPE_CUSTOM, PAD_SHAPE_CHAMFERED_RECT):
        name = "Cust[%s]Pad_%sx%s_um_%s" % (side, w, h, abs(hash(repr(pad._node))) % 100000)
        g = _pad_local_ring(pad)
        body = "(polygon %%s 0  %s)" % "  ".join("%s %s" % (_dsn_um(x), _dsn_um(-y)) for x, y in g)
    else:
        name = "Rect[%s]Pad_%sx%s_um" % (side, w, h)
        body = "(rect %%s %s %s %s %s)" % (_dsn_um(-s.x / 2.0), _dsn_um(-s.y / 2.0), _dsn_um(s.x / 2.0), _dsn_um(s.y / 2.0))
    lines = ["      (shape %s)" % (body % _layer_name(l)) for l in on]
    return name, lines + ["      (attach off)"]


def _pad_local_ring(pad):
    """The pad's outline about its own centre, unrotated (what a padstack is drawn in)."""
    try:
        g = _pad_geom(pad, None, 5000)
    except WebUnsupported:
        s = pad.GetSize()
        return [(-s.x / 2.0, -s.y / 2.0), (s.x / 2.0, -s.y / 2.0), (s.x / 2.0, s.y / 2.0), (-s.x / 2.0, s.y / 2.0)]
    p, rot = pad.GetPosition(), pad.GetOrientation().AsDegrees()
    hull = g.convex_hull if g.geom_type != "Polygon" else g
    out = []
    for x, y in list(hull.exterior.coords)[:-1]:
        out.append(_rot(x - p.x, y - p.y, -rot))
    return out


def ExportSpecctraDSN(*a):
    """ExportSpecctraDSN(board, path) / ExportSpecctraDSN(path): the board as a Specctra design file (.dsn) for an
    autorouter: layers, outline, rules, footprints with their pads, nets and the copper already laid."""
    board = a[0] if a and isinstance(a[0], BOARD) else GetBoard()
    path = str(a[-1])
    layers = [l for l in board.GetEnabledLayers().CuStack()]
    lname = _layer_name
    ds = board.GetDesignSettings()
    out = ['(pcb %s' % _dsn_q(path), "  (parser", '    (string_quote ")', "    (space_in_quoted_tokens on)",
           '    (host_cad "KiCad\'s Pcbnew")', '    (host_version "%s")' % GetBuildVersion(), "  )", "  (resolution um 10)", "  (unit um)", "  (structure"]
    plane = {}
    for z in board.Zones():
        if not z.GetIsRuleArea() and z.GetNetCode() > 0:
            for l in z.GetLayerSet().Seq():
                plane.setdefault(l, 0)
    for i, l in enumerate(layers):
        out += ["    (layer %s" % lname(l), "      (type signal)", "      (property", "        (index %d)" % i, "      )", "    )"]
    edge = SHAPE_POLY_SET()
    got = False
    try:
        got = board.GetBoardPolygonOutlines(edge)
    except WebUnsupported:
        got = False
    if got and edge.OutlineCount():
        for i in range(edge.OutlineCount()):
            pts = edge.Outline(i).CPoints()
            pts = list(pts) + [pts[0]]
            out += ["    (boundary", "      (path pcb 0  %s)" % "  ".join("%s %s" % (_dsn_um(p.x), _dsn_um(-p.y)) for p in pts), "    )"]
            for hno in range(edge.HoleCount(i)):
                hp = edge.Hole(i, hno).CPoints()
                out.append('    (keepout "" (polygon signal 0  %s))' % "  ".join("%s %s" % (_dsn_um(p.x), _dsn_um(-p.y)) for p in list(hp) + [hp[0]]))
    else:
        b = board.ComputeBoundingBox(True)
        out += ["    (boundary", "      (rect pcb %s %s %s %s)" % (_dsn_um(b.GetLeft()), _dsn_um(-b.GetBottom()), _dsn_um(b.GetRight()), _dsn_um(-b.GetTop())), "    )"]
    for z in board.Zones():
        if z.GetIsRuleArea() and (z._keepout("tracks") or z._keepout("vias")):
            kind = "keepout" if z._keepout("tracks") and z._keepout("vias") else ("via_keepout" if z._keepout("vias") else "wire_keepout")
            o = z.Outline()
            for i in range(o.OutlineCount()):
                pts = list(o.Outline(i).CPoints())
                for l in z.GetLayerSet().Seq():
                    if l in layers and pts:
                        out.append('    (%s "" (polygon %s 0  %s))' % (kind, lname(l), "  ".join("%s %s" % (_dsn_um(p.x), _dsn_um(-p.y)) for p in pts + [pts[0]])))
    classes = _netclasses()
    default = classes.get("Default") or next(iter(classes.values()))
    vd, vh = default.GetViaDiameter(), default.GetViaDrill()
    via_name = "Via[0-%d]_%s:%s_um" % (len(layers) - 1, _dsn_um(vd), _dsn_um(vh))
    out += ['    (via "%s")' % via_name, "    (rule", "      (width %s)" % _dsn_um(default.GetTrackWidth()),
            "      (clearance %s)" % _dsn_um(default.GetClearance()), "      (clearance %s (type default_smd))" % _dsn_um(default.GetClearance()),
            "      (clearance %s (type smd_smd))" % _dsn_um(default.GetClearance() / 4.0), "    )", "  )", "  (placement"]
    stacks, images, placed = {}, {}, {}
    for fp in board.GetFootprints():
        name = str(fp.GetFPID().GetUniStringLibId()) if hasattr(fp.GetFPID(), "GetUniStringLibId") else str(fp.GetFPIDAsString())
        back = fp.IsFlipped()
        rot = fp.GetOrientation().AsDegrees()
        o = fp.GetPosition()
        pins, seen = [], {}
        for pad in fp.Pads():
            if not any(pad.IsOnLayer(l) for l in layers):
                continue
            sname, lines = _dsn_padstack(pad, layers)
            stacks.setdefault(sname, lines)
            p = pad.GetPosition()
            lx, ly = _rot(p.x - o.x, p.y - o.y, -rot)
            if back:
                lx = -lx
            num = str(pad.GetNumber()) or "~"
            seen[num] = seen.get(num, 0) + 1
            pin = num if seen[num] == 1 else "%s@%d" % (num, seen[num] - 1)
            prot = (pad.GetOrientation().AsDegrees() - rot) % 360
            pins.append("      (pin %s %s%s %s %s)" % (_dsn_q(sname), "(rotate %s) " % _num(prot) if prot else "", _dsn_q(pin), _dsn_um(lx), _dsn_um(-ly)))
        key = (name, tuple(pins))
        if key not in images:
            n = sum(1 for k in images if k[0] == name)
            images[key] = (name if n == 0 else "%s::%d" % (name, n), pins)
        iname = images[key][0]
        placed.setdefault(iname, []).append("      (place %s %s %s %s %s (PN %s))" % (
            _dsn_q(fp.GetReference()), _dsn_um(o.x), _dsn_um(-o.y), "back" if back else "front", _num(rot % 360), _dsn_q(fp.GetValue())))
    for iname, rows in placed.items():
        out += ["    (component %s" % _dsn_q(iname)] + rows + ["    )"]
    out += ["  )", "  (library"]
    for iname, pins in images.values():
        out += ["    (image %s" % _dsn_q(iname)] + pins + ["    )"]
    for sname, lines in stacks.items():
        out += ["    (padstack %s" % _dsn_q(sname)] + lines + ["    )"]
    out += ['    (padstack "%s"' % via_name] + ["      (shape (circle %s %s))" % (lname(l), _dsn_um(vd)) for l in layers] + ["      (attach off)", "    )", "  )", "  (network"]
    nets = {}
    for fp in board.GetFootprints():
        seen = {}
        for pad in fp.Pads():
            if not any(pad.IsOnLayer(l) for l in layers):
                continue
            num = str(pad.GetNumber()) or "~"
            seen[num] = seen.get(num, 0) + 1
            n = pad.GetNetname()
            if n:
                nets.setdefault(n, []).append("%s-%s" % (fp.GetReference(), num if seen[num] == 1 else "%s@%d" % (num, seen[num] - 1)))
    for n, pins in nets.items():
        out += ["    (net %s" % _dsn_q(n), "      (pins %s)" % " ".join(_dsn_q(p) for p in pins), "    )"]
    by_class = {}
    for n in nets:
        by_class.setdefault(_netclass_name(n), []).append(n)
    for cname, members in by_class.items():
        nc = classes.get(cname, default)
        out += ["    (class %s %s" % (_dsn_q("kicad_default" if cname == "Default" else cname), " ".join(['""'] + [_dsn_q(m) for m in members])),
                "      (circuit", '        (use_via "%s")' % via_name, "      )", "      (rule", "        (width %s)" % _dsn_um(nc.GetTrackWidth()),
                "        (clearance %s)" % _dsn_um(nc.GetClearance()), "      )", "    )"]
    out += ["  )", "  (wiring"]
    for t in board.GetTracks():
        kind = "protect" if t.IsLocked() else "route"
        if isinstance(t, PCB_VIA):
            p = t.GetPosition()
            out.append('    (via "%s"  %s %s (net %s)(type %s))' % (via_name, _dsn_um(p.x), _dsn_um(-p.y), _dsn_q(t.GetNetname()), kind))
        else:
            pts = [VECTOR2I(int(x), int(y)) for x, y in _arc_points(t.GetStart(), t.GetMid(), t.GetEnd())] if isinstance(t, PCB_ARC) else [t.GetStart(), t.GetEnd()]
            out.append("    (wire (path %s %s  %s)(net %s)(type %s))" % (lname(t.GetLayer()), _dsn_um(t.GetWidth()),
                       "  ".join("%s %s" % (_dsn_um(p.x), _dsn_um(-p.y)) for p in pts), _dsn_q(t.GetNetname()), kind))
    out += ["  )", ")", ""]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out))
    return True


# Plugins written with `from pcbnew import *` lean on a few math names coming along with it.
from math import floor, ceil  # noqa: E402,F401


class _Placeholder:
    def __init__(self, name):
        self.__dict__["_name"] = name

    def __call__(self, *a, **k):
        _unsupported(f"pcbnew.{self._name}")

    def __getattr__(self, attr):
        if attr.startswith("__"):
            raise AttributeError(attr)
        return _Placeholder(f"{self._name}.{attr}")

    def __int__(self):
        return 0

    __index__ = __int__

    def __float__(self):
        return 0.0

    def __add__(self, o):
        return o

    __radd__ = __add__

    def __sub__(self, o):
        return -o

    def __rsub__(self, o):
        return o

    def __mul__(self, o):
        return 0

    __rmul__ = __mul__
    __or__ = __ror__ = __add__

    def __and__(self, o):
        return 0

    __rand__ = __and__

    def __lt__(self, o):
        return 0 < o

    def __gt__(self, o):
        return 0 > o

    def __le__(self, o):
        return 0 <= o

    def __ge__(self, o):
        return 0 >= o

    def __eq__(self, o):
        return o is self or o == 0

    def __hash__(self):
        return hash(self._name)

    def __iter__(self):
        return iter(())

    def __repr__(self):
        return f"<pcbnew.{self._name}: not available in the web editor>"

    def __mro_entries__(self, bases):
        return (object,)


# Class names KiCad dropped after version 5 or 6.  A plugin that asks "hasattr(pcbnew, 'TRACK')" wants to know
# which KiCad it runs in, and the answer here is KiCad 10's: no.  A plugin written for the old names alone, which
# uses them without asking (pcbnew.TRACK(board), from pcbnew import D_PAD), still gets today's class for it.
_LEGACY = {"EDA_RECT": "BOX2I", "TRACK": "PCB_TRACK", "VIA": "PCB_VIA", "MODULE": "FOOTPRINT", "D_PAD": "PAD", "DRAWSEGMENT": "PCB_SHAPE",
           "ZONE_CONTAINER": "ZONE", "TEXTE_PCB": "PCB_TEXT", "TEXTE_MODULE": "PCB_TEXT", "EDGE_MODULE": "PCB_SHAPE", "FP_TEXT": "PCB_TEXT",
           "FP_SHAPE": "PCB_SHAPE"}


def _asked_whether(depth=2):
    """Whether the caller's caller is calling a function (hasattr, getattr) and not reading an attribute or importing."""
    import dis
    import sys
    try:
        frame = sys._getframe(depth)
        return dis.opname[frame.f_code.co_code[frame.f_lasti]].startswith("CALL")
    except Exception:
        return False


def __getattr__(name):
    if name.startswith("__") or not name.isidentifier():
        raise AttributeError(name)
    if name in _LEGACY:
        if _asked_whether():
            raise AttributeError(name)
        return globals()[_LEGACY[name]]
    _missing.add(name)
    return _Placeholder(name)
