"""PySide6.QtGui for the web editor: colours, fonts, icons, actions and the pieces of painting plugins name."""

import enum
import os

import wx

from .QtCore import QObject, QPoint, QPointF, QRect, QRectF, QSize, Qt, QUrl, Signal, QEvent

_GLOBAL = {"black": "#000000", "white": "#ffffff", "darkGray": "#808080", "gray": "#a0a0a4", "lightGray": "#c0c0c0", "red": "#ff0000",
           "green": "#00ff00", "blue": "#0000ff", "cyan": "#00ffff", "magenta": "#ff00ff", "yellow": "#ffff00", "darkRed": "#800000",
           "darkGreen": "#008000", "darkBlue": "#000080", "darkCyan": "#008080", "darkMagenta": "#800080", "darkYellow": "#808000",
           "transparent": "#00000000", "color0": "#000000", "color1": "#ffffff"}


class QColor:
    def __init__(self, *a):
        self._c = (0, 0, 0, 255)
        self._valid = True
        if not a:
            self._valid = False
        elif len(a) >= 3:
            self._c = (int(a[0]), int(a[1]), int(a[2]), int(a[3]) if len(a) > 3 else 255)
        elif isinstance(a[0], QColor):
            self._c, self._valid = a[0]._c, a[0]._valid
        elif isinstance(a[0], enum.Enum) and a[0].name in _GLOBAL:
            self._hex(_GLOBAL[a[0].name])
        elif isinstance(a[0], str):
            self._hex(a[0])
        elif isinstance(a[0], int):
            v = a[0]
            self._c = ((v >> 16) & 255, (v >> 8) & 255, v & 255, 255)

    def _hex(self, s):
        s = s.strip()
        if s in _GLOBAL:
            s = _GLOBAL[s]
        if not s.startswith("#"):
            c = wx.Colour(s)
            try:
                self._c = (c.Red(), c.Green(), c.Blue(), c.Alpha())
            except Exception:
                self._valid = False
            return
        h = s[1:]
        try:
            if len(h) == 3:
                self._c = tuple(int(ch * 2, 16) for ch in h) + (255,)
            elif len(h) == 6:
                self._c = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)
            elif len(h) == 8:            # Qt writes #AARRGGBB
                self._c = (int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16), int(h[0:2], 16))
            else:
                self._valid = False
        except ValueError:
            self._valid = False

    red = lambda self: self._c[0]
    green = lambda self: self._c[1]
    blue = lambda self: self._c[2]
    alpha = lambda self: self._c[3]
    redF = lambda self: self._c[0] / 255
    greenF = lambda self: self._c[1] / 255
    blueF = lambda self: self._c[2] / 255
    alphaF = lambda self: self._c[3] / 255
    isValid = lambda self: self._valid

    def setAlpha(self, a):
        self._c = self._c[:3] + (int(a),)

    def setAlphaF(self, a):
        self._c = self._c[:3] + (int(round(a * 255)),)

    def setRgb(self, r, g, b, a=255):
        self._c = (int(r), int(g), int(b), int(a))

    def setNamedColor(self, s):
        self._hex(str(s))

    def getRgb(self):
        return self._c

    def getRgbF(self):
        return tuple(v / 255 for v in self._c)

    def toTuple(self):
        return self._c

    def rgb(self):
        return 0xff000000 | (self._c[0] << 16) | (self._c[1] << 8) | self._c[2]

    rgba = lambda self: (self._c[3] << 24) | (self._c[0] << 16) | (self._c[1] << 8) | self._c[2]

    class NameFormat(enum.IntEnum):
        HexRgb = 0
        HexArgb = 1

    HexRgb, HexArgb = NameFormat.HexRgb, NameFormat.HexArgb

    def name(self, fmt=0):
        if int(fmt) == 1:
            return "#%02x%02x%02x%02x" % (self._c[3], self._c[0], self._c[1], self._c[2])
        return "#%02x%02x%02x" % self._c[:3]

    def _css(self):
        if self._c[3] == 255:
            return self.name()
        return "rgba(%d,%d,%d,%.3f)" % (self._c[0], self._c[1], self._c[2], self._c[3] / 255)

    def _hsl(self):
        import colorsys
        return colorsys.rgb_to_hls(self._c[0] / 255, self._c[1] / 255, self._c[2] / 255)

    def lightness(self):
        return int(round(self._hsl()[1] * 255))

    def lightnessF(self):
        return self._hsl()[1]

    def value(self):
        return max(self._c[:3])

    def hue(self):
        return int(round(self._hsl()[0] * 359))

    def saturation(self):
        return int(round(self._hsl()[2] * 255))

    def lighter(self, factor=150):
        import colorsys
        h, s, v = colorsys.rgb_to_hsv(self._c[0] / 255, self._c[1] / 255, self._c[2] / 255)
        v = min(1.0, v * factor / 100)
        r, g, b = colorsys.hsv_to_rgb(h, s, v)
        return QColor(int(r * 255), int(g * 255), int(b * 255), self._c[3])

    def darker(self, factor=200):
        return self.lighter(int(10000 / max(1, factor)))

    @staticmethod
    def fromRgb(r, g=None, b=None, a=255):
        return QColor(r) if g is None else QColor(r, g, b, a)

    @staticmethod
    def fromRgbF(r, g, b, a=1.0):
        return QColor(int(r * 255), int(g * 255), int(b * 255), int(a * 255))

    @staticmethod
    def fromHsv(h, s, v, a=255):
        import colorsys
        r, g, b = colorsys.hsv_to_rgb((h % 360) / 360, s / 255, v / 255)
        return QColor(int(r * 255), int(g * 255), int(b * 255), a)

    @staticmethod
    def fromHsl(h, s, l, a=255):
        import colorsys
        r, g, b = colorsys.hls_to_rgb((h % 360) / 360, l / 255, s / 255)
        return QColor(int(r * 255), int(g * 255), int(b * 255), a)

    @staticmethod
    def fromString(s):
        return QColor(s)

    @staticmethod
    def isValidColor(s):
        return QColor(s).isValid()

    isValidColorName = isValidColor

    def __eq__(self, o):
        return isinstance(o, QColor) and o._c == self._c

    def __hash__(self):
        return hash(self._c)

    def __repr__(self):
        return "QColor(%d, %d, %d, %d)" % self._c


def qRgb(r, g, b):
    return 0xff000000 | (r << 16) | (g << 8) | b


def qRgba(r, g, b, a):
    return (a << 24) | (r << 16) | (g << 8) | b


class QBrush:
    def __init__(self, *a):
        self._color = QColor(a[0]) if a and not isinstance(a[0], QGradient) else QColor(0, 0, 0)
        self._style = a[1] if len(a) > 1 else Qt.BrushStyle.SolidPattern

    color = lambda self: self._color
    style = lambda self: self._style

    def setColor(self, c):
        self._color = QColor(c)

    def setStyle(self, s):
        self._style = s


class QPen:
    def __init__(self, *a):
        self._color = QColor(a[0]) if a and not isinstance(a[0], (int, float)) or (a and isinstance(a[0], enum.Enum)) else QColor(0, 0, 0)
        self._width = a[1] if len(a) > 1 else 1

    color = lambda self: self._color
    width = widthF = lambda self: self._width

    def setColor(self, c):
        self._color = QColor(c)

    def setWidth(self, w):
        self._width = w

    setWidthF = setWidth
    setStyle = setCapStyle = setJoinStyle = setCosmetic = setDashPattern = setBrush = lambda self, *a: None


class QGradient:
    class Spread(enum.IntEnum):
        PadSpread = 0
        ReflectSpread = 1
        RepeatSpread = 2

    class CoordinateMode(enum.IntEnum):
        LogicalMode = 0
        StretchToDeviceMode = 1
        ObjectBoundingMode = 2
        ObjectMode = 3

    def __init__(self, *a):
        self._stops = []

    def setColorAt(self, pos, color):
        self._stops.append((pos, QColor(color)))

    setSpread = setCoordinateMode = setStops = lambda self, *a: None
    stops = lambda self: list(self._stops)


class QLinearGradient(QGradient):
    pass


class QRadialGradient(QGradient):
    pass


class QConicalGradient(QGradient):
    pass


class QPalette:
    class ColorRole(enum.IntEnum):
        WindowText = 0
        Button = 1
        Light = 2
        Midlight = 3
        Dark = 4
        Mid = 5
        Text = 6
        BrightText = 7
        ButtonText = 8
        Base = 9
        Window = 10
        Shadow = 11
        Highlight = 12
        HighlightedText = 13
        Link = 14
        LinkVisited = 15
        AlternateBase = 16
        NoRole = 17
        ToolTipBase = 18
        ToolTipText = 19
        PlaceholderText = 20
        Accent = 21

    class ColorGroup(enum.IntEnum):
        Active = 0
        Disabled = 1
        Inactive = 2
        All = 5
        Normal = 0

    def __init__(self, *a):
        self._colors = {}

    def _default(self, role):
        name = QPalette.ColorRole(int(role)).name
        get = wx.SystemSettings.GetColour
        table = {"Window": wx.SYS_COLOUR_WINDOW, "Base": wx.SYS_COLOUR_WINDOW, "Button": wx.SYS_COLOUR_BTNFACE,
                 "WindowText": wx.SYS_COLOUR_WINDOWTEXT, "Text": wx.SYS_COLOUR_WINDOWTEXT, "ButtonText": wx.SYS_COLOUR_BTNTEXT,
                 "Highlight": wx.SYS_COLOUR_HIGHLIGHT, "HighlightedText": wx.SYS_COLOUR_HIGHLIGHTTEXT, "AlternateBase": wx.SYS_COLOUR_BTNFACE}
        try:
            c = get(table.get(name, wx.SYS_COLOUR_WINDOWTEXT))
            return QColor(c.Red(), c.Green(), c.Blue())
        except Exception:
            return QColor(0, 0, 0)

    def color(self, *a):
        role = a[-1]
        return self._colors.get(int(role)) or self._default(role)

    def brush(self, *a):
        return QBrush(self.color(*a))

    def setColor(self, *a):
        self._colors[int(a[-2])] = QColor(a[-1])

    def setBrush(self, *a):
        b = a[-1]
        self._colors[int(a[-2])] = b.color() if isinstance(b, QBrush) else QColor(b)

    window = lambda self: QBrush(self.color(QPalette.ColorRole.Window))
    windowText = lambda self: QBrush(self.color(QPalette.ColorRole.WindowText))
    base = lambda self: QBrush(self.color(QPalette.ColorRole.Base))
    text = lambda self: QBrush(self.color(QPalette.ColorRole.Text))
    button = lambda self: QBrush(self.color(QPalette.ColorRole.Button))
    buttonText = lambda self: QBrush(self.color(QPalette.ColorRole.ButtonText))
    highlight = lambda self: QBrush(self.color(QPalette.ColorRole.Highlight))
    highlightedText = lambda self: QBrush(self.color(QPalette.ColorRole.HighlightedText))
    mid = lambda self: QBrush(self.color(QPalette.ColorRole.Mid))
    dark = lambda self: QBrush(self.color(QPalette.ColorRole.Dark))
    light = lambda self: QBrush(self.color(QPalette.ColorRole.Light))
    alternateBase = lambda self: QBrush(self.color(QPalette.ColorRole.AlternateBase))
    placeholderText = lambda self: QBrush(self.color(QPalette.ColorRole.PlaceholderText))
    link = lambda self: QBrush(self.color(QPalette.ColorRole.Link))


for _group in (QPalette.ColorRole, QPalette.ColorGroup):
    for _m in _group:
        setattr(QPalette, _m.name, _m)
QPalette.Normal = QPalette.ColorGroup.Active


class QFont:
    class Weight(enum.IntEnum):
        Thin = 100
        ExtraLight = 200
        Light = 300
        Normal = 400
        Medium = 500
        DemiBold = 600
        Bold = 700
        ExtraBold = 800
        Black = 900

    class StyleHint(enum.IntEnum):
        AnyStyle = 5
        SansSerif = 0
        Helvetica = 0
        Serif = 1
        Times = 1
        TypeWriter = 2
        Courier = 2
        Monospace = 7
        System = 4

    class Style(enum.IntEnum):
        StyleNormal = 0
        StyleItalic = 1
        StyleOblique = 2

    class Capitalization(enum.IntEnum):
        MixedCase = 0
        AllUppercase = 1

    class SpacingType(enum.IntEnum):
        PercentageSpacing = 0
        AbsoluteSpacing = 1

    def __init__(self, family="", size=-1, weight=-1, italic=False):
        if isinstance(family, QFont):
            self.__dict__.update(family.__dict__)
            return
        self._family = family if isinstance(family, str) else ""
        self._size, self._px = size, -1
        self._bold = int(weight) >= 600 if weight != -1 else False
        self._italic, self._underline, self._mono = bool(italic), False, False

    family = lambda self: self._family
    pointSize = lambda self: self._size
    pointSizeF = lambda self: float(self._size)
    pixelSize = lambda self: self._px
    bold = lambda self: self._bold
    italic = lambda self: self._italic
    underline = lambda self: self._underline
    weight = lambda self: QFont.Weight.Bold if self._bold else QFont.Weight.Normal

    def setFamily(self, f):
        self._family = str(f)

    def setFamilies(self, fs):
        self._family = ", ".join(str(f) for f in fs)

    families = lambda self: [f.strip() for f in self._family.split(",") if f.strip()]

    def setPointSize(self, s):
        self._size = s

    setPointSizeF = setPointSize

    def setPixelSize(self, s):
        self._px = s

    def setBold(self, on):
        self._bold = bool(on)

    def setItalic(self, on):
        self._italic = bool(on)

    def setUnderline(self, on):
        self._underline = bool(on)

    def setWeight(self, w):
        self._bold = int(w) >= 600

    def setStyleHint(self, hint, *a):
        self._mono = int(hint) in (2, 7)

    def setFixedPitch(self, on):
        self._mono = bool(on)

    setKerning = setStrikeOut = setLetterSpacing = setCapitalization = setStyleStrategy = setStyle = setStretch = setHintingPreference = lambda self, *a: None
    fixedPitch = lambda self: self._mono

    def _apply(self, style):
        if self._family:
            style.fontFamily = self._family
        elif self._mono:
            style.fontFamily = "var(--mono)"
        if self._px and self._px > 0:
            style.fontSize = f"{self._px}px"
        elif self._size and self._size > 0:
            style.fontSize = f"{self._size}pt"
        style.fontWeight = "600" if self._bold else ""
        style.fontStyle = "italic" if self._italic else ""
        style.textDecoration = "underline" if self._underline else ""


for _group in (QFont.Weight, QFont.StyleHint, QFont.Style):
    for _m in _group:
        if not hasattr(QFont, _m.name):
            setattr(QFont, _m.name, _m)


class QFontMetrics:
    def __init__(self, font=None, *a):
        self._font = font if isinstance(font, QFont) else QFont()

    def _em(self):
        f = self._font
        if f._px and f._px > 0:
            return f._px
        return (f._size if f._size and f._size > 0 else 9) * 4 / 3

    def horizontalAdvance(self, text, *a):
        return int(len(str(text)) * self._em() * 0.55)

    width = horizontalAdvance

    def height(self):
        return int(self._em() * 1.3)

    lineSpacing = height
    ascent = lambda self: int(self._em())
    descent = lambda self: int(self._em() * 0.3)
    averageCharWidth = lambda self: int(self._em() * 0.55)

    def boundingRect(self, *a):
        text = next((x for x in a if isinstance(x, str)), "")
        return QRect(0, 0, self.horizontalAdvance(text), self.height())

    def elidedText(self, text, mode, width, *a):
        n = max(1, int(width / max(1, self._em() * 0.55)))
        return text if len(text) <= n else text[:max(1, n - 1)] + "…"

    size = lambda self, flags, text, *a: QSize(self.horizontalAdvance(text), self.height())


QFontMetricsF = QFontMetrics


class QFontInfo:
    def __init__(self, font=None):
        self._font = font if isinstance(font, QFont) else QFont()

    family = lambda self: self._font.family() or "sans-serif"
    pointSize = lambda self: self._font.pointSize() if self._font.pointSize() > 0 else 9
    fixedPitch = lambda self: self._font._mono


class QFontDatabase:
    class SystemFont(enum.IntEnum):
        GeneralFont = 0
        FixedFont = 1
        TitleFont = 2
        SmallestReadableFont = 3

    GeneralFont, FixedFont, TitleFont, SmallestReadableFont = SystemFont.GeneralFont, SystemFont.FixedFont, SystemFont.TitleFont, SystemFont.SmallestReadableFont

    @staticmethod
    def systemFont(kind=0):
        f = QFont()
        f._mono = int(kind) == 1
        return f

    @staticmethod
    def families(*a):
        return ["sans-serif", "serif", "monospace"]

    @staticmethod
    def addApplicationFont(path):
        return -1

    @staticmethod
    def applicationFontFamilies(i):
        return []

    @staticmethod
    def hasFamily(name):
        return False


class QPixmap:
    def __init__(self, *a):
        self._path, self._w, self._h = "", 0, 0
        if a and isinstance(a[0], str):
            self._path = a[0]
        elif a and isinstance(a[0], QPixmap):
            self._path, self._w, self._h = a[0]._path, a[0]._w, a[0]._h
        elif len(a) >= 2 and all(isinstance(v, (int, float)) for v in a[:2]):
            self._w, self._h = int(a[0]), int(a[1])
        elif a and isinstance(a[0], QSize):
            self._w, self._h = a[0].width(), a[0].height()

    def load(self, path, *a):
        self._path = str(path)
        return os.path.exists(self._path)

    def isNull(self):
        return not (self._path and os.path.exists(self._path)) and not (self._w and self._h)

    width = lambda self: self._w
    height = lambda self: self._h
    size = lambda self: QSize(self._w, self._h)
    rect = lambda self: QRect(0, 0, self._w, self._h)
    devicePixelRatio = lambda self: 1.0

    def scaled(self, *a, **k):
        p = QPixmap(self)
        if a and isinstance(a[0], QSize):
            p._w, p._h = a[0].width(), a[0].height()
        elif len(a) >= 2 and isinstance(a[0], (int, float)):
            p._w, p._h = int(a[0]), int(a[1])
        return p

    scaledToWidth = scaledToHeight = lambda self, *a: QPixmap(self)
    copy = transformed = lambda self, *a: QPixmap(self)
    toImage = lambda self: QImage(self._path) if self._path else QImage(self._w, self._h)
    fill = setDevicePixelRatio = setMask = lambda self, *a: None

    def save(self, path, *a):
        return False

    @staticmethod
    def fromImage(img, *a):
        p = QPixmap()
        p._path, p._w, p._h = getattr(img, "_path", ""), getattr(img, "_w", 0), getattr(img, "_h", 0)
        return p

    def _url(self):
        return wx._data_url(self._path) if self._path and os.path.exists(self._path) else ""


class QImage(QPixmap):
    class Format(enum.IntEnum):
        Format_Invalid = 0
        Format_RGB32 = 4
        Format_ARGB32 = 5
        Format_ARGB32_Premultiplied = 6
        Format_RGB888 = 13
        Format_RGBA8888 = 17
        Format_Grayscale8 = 24

    def setPixelColor(self, *a):
        pass

    setPixel = lambda self, *a: None
    pixelColor = lambda self, *a: QColor(0, 0, 0)
    bits = constBits = lambda self: b""
    format = lambda self: QImage.Format.Format_ARGB32
    convertToFormat = lambda self, *a: self


for _m in QImage.Format:
    setattr(QImage, _m.name, _m)
QBitmap = QPixmap


class QIcon:
    class Mode(enum.IntEnum):
        Normal = 0
        Disabled = 1
        Active = 2
        Selected = 3

    class State(enum.IntEnum):
        On = 0
        Off = 1

    Normal, Disabled, Active, Selected, On, Off = Mode.Normal, Mode.Disabled, Mode.Active, Mode.Selected, State.On, State.Off

    def __init__(self, src=None):
        self._path = ""
        if isinstance(src, str):
            self._path = src
        elif isinstance(src, (QPixmap, QIcon)):
            self._path = src._path

    def addFile(self, path, *a):
        if not self._path:
            self._path = str(path)

    def addPixmap(self, pm, *a):
        if not self._path:
            self._path = pm._path

    def isNull(self):
        return not (self._path and os.path.exists(self._path))

    def pixmap(self, *a):
        p = QPixmap(self._path)
        return p

    @staticmethod
    def fromTheme(name, fallback=None):
        return fallback if isinstance(fallback, QIcon) else QIcon()

    @staticmethod
    def hasThemeIcon(name):
        return False

    @staticmethod
    def setThemeName(*a):
        pass

    themeName = staticmethod(lambda: "")
    availableSizes = lambda self, *a: []
    actualSize = lambda self, size, *a: size

    def _url(self):
        return wx._data_url(self._path) if self._path and os.path.exists(self._path) else ""


class QKeySequence:
    class StandardKey(enum.IntEnum):
        UnknownKey = 0
        HelpContents = 1
        Open = 3
        Close = 4
        Save = 5
        New = 6
        Delete = 7
        Cut = 8
        Copy = 9
        Paste = 10
        Undo = 11
        Redo = 12
        Refresh = 18
        ZoomIn = 19
        ZoomOut = 20
        Print = 21
        Find = 28
        SelectAll = 35
        Quit = 61
        Preferences = 60
        SaveAs = 63
        Cancel = 71

    class SequenceFormat(enum.IntEnum):
        NativeText = 0
        PortableText = 1

    NativeText, PortableText = SequenceFormat.NativeText, SequenceFormat.PortableText

    def __init__(self, *a):
        self._text = a[0] if a and isinstance(a[0], str) else ""

    def toString(self, *a):
        return self._text

    isEmpty = lambda self: not self._text

    @staticmethod
    def fromString(s, *a):
        return QKeySequence(s)

    def __str__(self):
        return self._text


for _m in QKeySequence.StandardKey:
    setattr(QKeySequence, _m.name, _m)


class QCursor:
    def __init__(self, *a):
        pass

    @staticmethod
    def pos():
        return QPoint(0, 0)

    @staticmethod
    def setPos(*a):
        pass

    shape = lambda self: Qt.CursorShape.ArrowCursor


class QTransform:
    def __init__(self, *a):
        pass

    def _same(self, *a):
        return self

    translate = scale = rotate = shear = inverted = _same
    map = lambda self, p, *a: p
    mapRect = lambda self, r: r
    m11 = m22 = lambda self: 1.0
    m12 = m21 = dx = dy = lambda self: 0.0
    isIdentity = lambda self: True


class QPainterPath:
    def __init__(self, *a):
        self._pts = []

    def moveTo(self, *a):
        self._pts.append(a)

    lineTo = cubicTo = quadTo = arcTo = addRect = addEllipse = addRoundedRect = addPolygon = addPath = addText = moveTo
    closeSubpath = lambda self: None
    setFillRule = lambda self, *a: None
    isEmpty = lambda self: not self._pts
    boundingRect = controlPointRect = lambda self: QRectF(0, 0, 0, 0)
    contains = intersects = lambda self, *a: False
    simplified = translated = lambda self, *a: self


class QPolygon(list):
    def __init__(self, pts=()):
        list.__init__(self, pts)

    def boundingRect(self):
        if not self:
            return QRect()
        xs, ys = [p.x() for p in self], [p.y() for p in self]
        return QRect(min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))

    containsPoint = lambda self, *a: False
    translated = lambda self, *a: self


QPolygonF = QPolygon


class QPainter:
    """Custom painting.  A widget in the web editor is HTML, so there is nothing to paint on: the calls are accepted."""

    class RenderHint(enum.IntFlag):
        Antialiasing = 1
        TextAntialiasing = 2
        SmoothPixmapTransform = 4
        LosslessImageRendering = 0x40

    class CompositionMode(enum.IntEnum):
        CompositionMode_SourceOver = 0
        CompositionMode_Source = 3
        CompositionMode_Clear = 2

    Antialiasing, TextAntialiasing, SmoothPixmapTransform = RenderHint.Antialiasing, RenderHint.TextAntialiasing, RenderHint.SmoothPixmapTransform
    CompositionMode_SourceOver, CompositionMode_Source, CompositionMode_Clear = (CompositionMode.CompositionMode_SourceOver,
                                                                                CompositionMode.CompositionMode_Source, CompositionMode.CompositionMode_Clear)

    def __init__(self, device=None):
        self._device = device
        self._pen, self._brush, self._font = QPen(), QBrush(), QFont()

    def begin(self, device):
        self._device = device
        return True

    def end(self):
        return True

    def isActive(self):
        return True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def pen(self):
        return self._pen

    def setPen(self, p):
        self._pen = p if isinstance(p, QPen) else QPen(p)

    def brush(self):
        return self._brush

    def setBrush(self, b):
        self._brush = b if isinstance(b, QBrush) else QBrush(b)

    def font(self):
        return self._font

    def setFont(self, f):
        self._font = f

    def fontMetrics(self):
        return QFontMetrics(self._font)

    def device(self):
        return self._device

    def window(self):
        return QRect(0, 0, 0, 0)

    viewport = window
    transform = worldTransform = lambda self: QTransform()
    opacity = lambda self: 1.0

    def boundingRect(self, *a):
        return QRect(0, 0, 0, 0)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


class QAction(QObject):
    triggered = Signal(bool)
    toggled = Signal(bool)
    changed = Signal()
    hovered = Signal()

    def __init__(self, *a):
        parent = next((x for x in a if isinstance(x, QObject)), None)
        super().__init__(parent)
        self._text = next((x for x in a if isinstance(x, str)), "")
        self._icon = next((x for x in a if isinstance(x, QIcon)), QIcon())
        self._enabled, self._visible, self._checkable, self._checked = True, True, False, False
        self._shortcut, self._tip, self._data, self._sep, self._menu = QKeySequence(), "", None, False, None
        self._q_hooks = []

    def _notify(self):
        for h in list(self._q_hooks):
            h(self)
        self.changed.emit()

    text = lambda self: self._text
    icon = lambda self: self._icon
    isEnabled = lambda self: self._enabled
    isVisible = lambda self: self._visible
    isCheckable = lambda self: self._checkable
    isChecked = lambda self: self._checked
    shortcut = lambda self: self._shortcut
    toolTip = statusTip = whatsThis = lambda self: self._tip
    data = lambda self: self._data
    isSeparator = lambda self: self._sep
    menu = lambda self: self._menu

    def setText(self, t):
        self._text = str(t)
        self._notify()

    def setIcon(self, i):
        self._icon = i
        self._notify()

    def setEnabled(self, on):
        self._enabled = bool(on)
        self._notify()

    def setDisabled(self, off):
        self.setEnabled(not off)

    def setVisible(self, on):
        self._visible = bool(on)
        self._notify()

    def setCheckable(self, on):
        self._checkable = bool(on)

    def setChecked(self, on):
        on = bool(on)
        if on != self._checked:
            self._checked = on
            self._notify()
            self.toggled.emit(on)

    def setShortcut(self, s):
        self._shortcut = s if isinstance(s, QKeySequence) else QKeySequence(str(s) if isinstance(s, str) else "")

    def setShortcuts(self, s):
        pass

    def setToolTip(self, t):
        self._tip = str(t)

    setStatusTip = setWhatsThis = setToolTip

    def setData(self, d):
        self._data = d

    def setSeparator(self, on):
        self._sep = bool(on)

    def setMenu(self, m):
        self._menu = m

    setShortcutContext = setMenuRole = setIconVisibleInMenu = setFont = setAutoRepeat = setIconText = setPriority = setActionGroup = lambda self, *a: None

    def trigger(self):
        if not self._enabled:
            return
        if self._checkable:
            self._checked = not self._checked
            self.toggled.emit(self._checked)
        self.triggered.emit(self._checked)

    def toggle(self):
        self.setChecked(not self._checked)


class QActionGroup(QObject):
    triggered = Signal(object)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._actions = []

    def addAction(self, a):
        self._actions.append(a)
        a.triggered.connect(lambda *_: self._picked(a))
        return a

    def _picked(self, a):
        for other in self._actions:
            if other is not a and other.isCheckable():
                other.setChecked(False)
        self.triggered.emit(a)

    actions = lambda self: list(self._actions)
    checkedAction = lambda self: next((a for a in self._actions if a.isChecked()), None)
    setExclusive = setEnabled = setVisible = lambda self, *a: None


class QShortcut(QObject):
    activated = Signal()

    def __init__(self, *a, **k):
        parent = next((x for x in a if isinstance(x, QObject)), None)
        super().__init__(parent)
        fn = next((x for x in a if callable(x) and not isinstance(x, QObject)), None)
        if fn is not None:
            self.activated.connect(fn)

    setKey = setContext = setEnabled = setAutoRepeat = lambda self, *a: None


class QDesktopServices:
    @staticmethod
    def openUrl(url):
        u = url.toString() if isinstance(url, QUrl) else str(url)
        if u.startswith("file://"):
            import kicad_web
            kicad_web._open_target(u[7:])
            return True
        wx.LaunchDefaultBrowser(u)
        return True


class QClipboard(QObject):
    dataChanged = Signal()

    def setText(self, text, *a):
        if wx.TheClipboard.Open():
            wx.TheClipboard.SetData(wx.TextDataObject(str(text)))
            wx.TheClipboard.Close()

    def text(self, *a):
        return ""

    setPixmap = setImage = setMimeData = clear = lambda self, *a: None


class QScreen(QObject):
    def geometry(self):
        return QRect(0, 0, 1920, 1080)

    availableGeometry = virtualGeometry = geometry
    size = availableSize = lambda self: QSize(1920, 1080)
    devicePixelRatio = lambda self: 1.0
    logicalDotsPerInch = physicalDotsPerInch = logicalDotsPerInchX = logicalDotsPerInchY = lambda self: 96.0
    name = lambda self: "browser"


class QStyleHints(QObject):
    colorSchemeChanged = Signal(object)

    def colorScheme(self):
        try:
            c = wx.SystemSettings.GetColour(wx.SYS_COLOUR_WINDOW)
            return Qt.ColorScheme.Dark if (c.Red() + c.Green() + c.Blue()) < 384 else Qt.ColorScheme.Light
        except Exception:
            return Qt.ColorScheme.Unknown

    setColorScheme = lambda self, *a: None
    mouseDoubleClickInterval = lambda self: 400
    cursorFlashTime = lambda self: 1000


class QGuiApplication:
    _clipboard = None
    _hints = None

    @staticmethod
    def clipboard():
        if QGuiApplication._clipboard is None:
            QGuiApplication._clipboard = QClipboard()
        return QGuiApplication._clipboard

    @staticmethod
    def primaryScreen():
        return QScreen()

    @staticmethod
    def screens():
        return [QScreen()]

    @staticmethod
    def screenAt(*a):
        return QScreen()

    @staticmethod
    def styleHints():
        if QGuiApplication._hints is None:
            QGuiApplication._hints = QStyleHints()
        return QGuiApplication._hints

    @staticmethod
    def palette(*a):
        return QPalette()

    @staticmethod
    def font(*a):
        return QFont()

    @staticmethod
    def keyboardModifiers():
        return Qt.KeyboardModifier.NoModifier

    queryKeyboardModifiers = keyboardModifiers
    mouseButtons = staticmethod(lambda: Qt.MouseButton.NoButton)
    setOverrideCursor = restoreOverrideCursor = setWindowIcon = setDesktopFileName = setPalette = setFont = setHighDpiScaleFactorRoundingPolicy = \
        setQuitOnLastWindowClosed = setApplicationDisplayName = setStyle = setLayoutDirection = staticmethod(lambda *a: None)
    overrideCursor = staticmethod(lambda: None)
    platformName = staticmethod(lambda: "web")
    devicePixelRatio = staticmethod(lambda *a: 1.0)


class QTextCursor:
    class MoveOperation(enum.IntEnum):
        NoMove = 0
        Start = 1
        StartOfLine = 3
        End = 11
        EndOfLine = 13

    class MoveMode(enum.IntEnum):
        MoveAnchor = 0
        KeepAnchor = 1

    class SelectionType(enum.IntEnum):
        WordUnderCursor = 0
        LineUnderCursor = 1
        BlockUnderCursor = 2
        Document = 3

    Start, End, StartOfLine, EndOfLine = MoveOperation.Start, MoveOperation.End, MoveOperation.StartOfLine, MoveOperation.EndOfLine
    MoveAnchor, KeepAnchor = MoveMode.MoveAnchor, MoveMode.KeepAnchor
    Document = SelectionType.Document

    def __init__(self, edit=None):
        self._edit = edit

    def insertText(self, text, *a):
        if self._edit is not None and hasattr(self._edit, "insertPlainText"):
            self._edit.insertPlainText(text)

    insertHtml = insertText

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None

    hasSelection = lambda self: False
    selectedText = lambda self: ""
    position = anchor = lambda self: 0


class QTextCharFormat:
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


QTextBlockFormat = QTextFormat = QTextOption = QTextCharFormat


class QTextDocument(QObject):
    def __init__(self, *a):
        super().__init__()
        self._text = next((x for x in a if isinstance(x, str)), "")

    def setPlainText(self, t):
        self._text = str(t)

    setHtml = setMarkdown = setPlainText
    toPlainText = toHtml = toMarkdown = lambda self: self._text
    setDefaultFont = setMaximumBlockCount = setDocumentMargin = setDefaultStyleSheet = setTextWidth = lambda self, *a: None
    blockCount = lambda self: self._text.count("\n") + 1
    isEmpty = lambda self: not self._text
    size = lambda self: QSize(0, 0)


class QSyntaxHighlighter(QObject):
    def __init__(self, parent=None):
        super().__init__(parent if isinstance(parent, QObject) else None)

    highlightBlock = rehighlight = setFormat = setDocument = setCurrentBlockState = lambda self, *a: None
    previousBlockState = currentBlockState = lambda self: -1


class QValidator(QObject):
    class State(enum.IntEnum):
        Invalid = 0
        Intermediate = 1
        Acceptable = 2

    Invalid, Intermediate, Acceptable = State.Invalid, State.Intermediate, State.Acceptable

    def validate(self, text, pos):
        return (QValidator.State.Acceptable, text, pos)

    fixup = lambda self, text: text
    setLocale = lambda self, *a: None


class QIntValidator(QValidator):
    def __init__(self, *a):
        super().__init__(next((x for x in a if isinstance(x, QObject)), None))
        nums = [x for x in a if isinstance(x, (int, float)) and not isinstance(x, bool)]
        self._lo, self._hi = (nums[0], nums[1]) if len(nums) >= 2 else (-2 ** 31, 2 ** 31 - 1)

    def setRange(self, lo, hi, *a):
        self._lo, self._hi = lo, hi

    setBottom = lambda self, v: setattr(self, "_lo", v)
    setTop = lambda self, v: setattr(self, "_hi", v)
    bottom = lambda self: self._lo
    top = lambda self: self._hi

    def validate(self, text, pos):
        try:
            v = int(text)
        except ValueError:
            return (QValidator.State.Intermediate if text in ("", "-", "+") else QValidator.State.Invalid, text, pos)
        return (QValidator.State.Acceptable if self._lo <= v <= self._hi else QValidator.State.Intermediate, text, pos)


class QDoubleValidator(QIntValidator):
    class Notation(enum.IntEnum):
        StandardNotation = 0
        ScientificNotation = 1

    StandardNotation, ScientificNotation = Notation.StandardNotation, Notation.ScientificNotation
    setDecimals = setNotation = lambda self, *a: None

    def validate(self, text, pos):
        try:
            v = float(text)
        except ValueError:
            return (QValidator.State.Intermediate if text in ("", "-", "+", ".") else QValidator.State.Invalid, text, pos)
        return (QValidator.State.Acceptable if self._lo <= v <= self._hi else QValidator.State.Intermediate, text, pos)


class QRegularExpressionValidator(QValidator):
    def __init__(self, *a):
        super().__init__(next((x for x in a if isinstance(x, QObject)), None))


class QStandardItem:
    def __init__(self, *a):
        self._text = next((x for x in a if isinstance(x, str)), "")
        self._data, self._check, self._flags = {}, None, Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsEditable
        self._model, self._children = None, []

    text = lambda self: self._text

    def setText(self, t):
        self._text = str(t)
        self._changed()

    def _changed(self):
        if self._model is not None:
            self._model._item_changed(self)

    def data(self, role=0x101):
        if int(role) in (0, 2):
            return self._text
        if int(role) == 10:
            return self._check
        return self._data.get(int(role))

    def setData(self, value, role=0x101):
        if int(role) in (0, 2):
            self._text = "" if value is None else str(value)
        elif int(role) == 10:
            self._check = Qt.CheckState(int(value))
        else:
            self._data[int(role)] = value
        self._changed()

    def setCheckable(self, on):
        if on:
            self._flags |= Qt.ItemFlag.ItemIsUserCheckable
            if self._check is None:
                self._check = Qt.CheckState.Unchecked

    isCheckable = lambda self: bool(self._flags & Qt.ItemFlag.ItemIsUserCheckable)
    checkState = lambda self: self._check if self._check is not None else Qt.CheckState.Unchecked

    def setCheckState(self, s):
        self._check = Qt.CheckState(int(s))
        self._changed()

    def setEditable(self, on):
        self._flags = (self._flags | Qt.ItemFlag.ItemIsEditable) if on else (self._flags & ~Qt.ItemFlag.ItemIsEditable)

    def setEnabled(self, on):
        self._flags = (self._flags | Qt.ItemFlag.ItemIsEnabled) if on else (self._flags & ~Qt.ItemFlag.ItemIsEnabled)

    def setFlags(self, f):
        self._flags = f

    flags = lambda self: self._flags
    setIcon = setToolTip = setForeground = setBackground = setFont = setTextAlignment = setSelectable = setSizeHint = lambda self, *a: None

    def appendRow(self, items):
        self._children.append(items if isinstance(items, list) else [items])

    rowCount = lambda self: len(self._children)
    child = lambda self, r, c=0: self._children[r][c] if r < len(self._children) and c < len(self._children[r]) else None
    index = lambda self: self._model.indexFromItem(self) if self._model is not None else None
    row = lambda self: self.index().row() if self._model is not None else -1
    model = lambda self: self._model


class QStandardItemModel(QObject):
    """A table of items; QtCore's model interface over it is added in QtWidgets (it needs QAbstractItemModel)."""


def _late():
    """QStandardItemModel needs QAbstractItemModel, defined in QtCore: finish it here to keep one definition."""
    from .QtCore import QAbstractItemModel, QModelIndex

    class Model(QAbstractItemModel):
        itemChanged = Signal(object)

        def __init__(self, *a):
            parent = next((x for x in a if isinstance(x, QObject)), None)
            super().__init__(parent)
            nums = [x for x in a if isinstance(x, int) and not isinstance(x, bool)]
            self._rows, self._headers = [], []
            self._ncols = nums[1] if len(nums) > 1 else 0
            for _ in range(nums[0] if nums else 0):
                self._rows.append([None] * self._ncols)

        def rowCount(self, parent=None):
            return len(self._rows)

        def columnCount(self, parent=None):
            return max([self._ncols, len(self._headers)] + [len(r) for r in self._rows])

        def _take(self, item):
            if item is not None:
                item._model = self
            return item

        def appendRow(self, items):
            items = items if isinstance(items, (list, tuple)) else [items]
            self._rows.append([self._take(i) for i in items])
            self.modelReset.emit()

        def insertRow(self, row, items=None):
            items = items if isinstance(items, (list, tuple)) else ([items] if isinstance(items, QStandardItem) else [])
            self._rows.insert(row, [self._take(i) for i in items])
            self.modelReset.emit()
            return True

        def setItem(self, row, col, item=None):
            if item is None:
                col, item = 0, col
            while len(self._rows) <= row:
                self._rows.append([])
            r = self._rows[row]
            while len(r) <= col:
                r.append(None)
            r[col] = self._take(item)
            self.modelReset.emit()

        def item(self, row, col=0):
            if 0 <= row < len(self._rows) and 0 <= col < len(self._rows[row]):
                return self._rows[row][col]
            return None

        def itemFromIndex(self, index):
            return self.item(index.row(), index.column())

        def indexFromItem(self, item):
            for r, row in enumerate(self._rows):
                for c, it in enumerate(row):
                    if it is item:
                        return self.index(r, c)
            return QModelIndex()

        def takeRow(self, row):
            out = self._rows.pop(row) if 0 <= row < len(self._rows) else []
            self.modelReset.emit()
            return out

        def removeRows(self, row, count, parent=None):
            del self._rows[row:row + count]
            self.modelReset.emit()
            return True

        def removeRow(self, row, parent=None):
            return self.removeRows(row, 1)

        def setRowCount(self, n):
            del self._rows[n:]
            while len(self._rows) < n:
                self._rows.append([])
            self.modelReset.emit()

        def setColumnCount(self, n):
            self._ncols = n

        def clear(self):
            self._rows, self._headers = [], []
            self.modelReset.emit()

        def setHorizontalHeaderLabels(self, labels):
            self._headers = [str(x) for x in labels]
            self.modelReset.emit()

        def setHorizontalHeaderItem(self, col, item):
            while len(self._headers) <= col:
                self._headers.append("")
            self._headers[col] = item.text()

        def headerData(self, section, orientation, role=0):
            if int(role) == 0 and int(orientation) == 1 and section < len(self._headers):
                return self._headers[section]
            return str(section + 1) if int(role) == 0 else None

        def data(self, index, role=0):
            it = self.itemFromIndex(index)
            return it.data(role) if it is not None else None

        def setData(self, index, value, role=2):
            it = self.itemFromIndex(index)
            if it is None:
                it = QStandardItem()
                self.setItem(index.row(), index.column(), it)
            it.setData(value, role)
            return True

        def flags(self, index):
            it = self.itemFromIndex(index)
            return it.flags() if it is not None else Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEnabled

        def invisibleRootItem(self):
            return _Root(self)

        def _item_changed(self, item):
            idx = self.indexFromItem(item)
            self.dataChanged.emit(idx, idx, [])
            self.itemChanged.emit(item)

        def findItems(self, text, flags=None, column=0):
            return [r[column] for r in self._rows if column < len(r) and r[column] is not None and r[column].text() == text]

    class _Root:
        def __init__(self, model):
            self._m = model

        def appendRow(self, items):
            self._m.appendRow(items)

        rowCount = lambda self: self._m.rowCount()
        child = lambda self, r, c=0: self._m.item(r, c)

    Model.__name__ = Model.__qualname__ = "QStandardItemModel"
    return Model


QStandardItemModel = _late()


class _InputEvent(QEvent):
    def __init__(self, *a, **k):
        QEvent.__init__(self, 0)
        self._pos, self._button, self._mods, self._key, self._text, self._delta = QPointF(0, 0), Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier, 0, "", 0

    pos = lambda self: self._pos.toPoint()
    position = scenePosition = globalPosition = lambda self: self._pos
    globalPos = lambda self: self._pos.toPoint()
    x = lambda self: int(self._pos.x())
    y = lambda self: int(self._pos.y())
    button = lambda self: self._button
    buttons = lambda self: self._button
    modifiers = lambda self: self._mods
    key = lambda self: self._key
    text = lambda self: self._text
    isAutoRepeat = lambda self: False
    angleDelta = pixelDelta = lambda self: QPoint(0, self._delta)
    matches = lambda self, *a: False


QMouseEvent = QKeyEvent = QWheelEvent = QHoverEvent = QEnterEvent = QContextMenuEvent = QDragEnterEvent = QDropEvent = QDragMoveEvent = _InputEvent


class QResizeEvent(QEvent):
    def __init__(self, size=None, old=None):
        QEvent.__init__(self, QEvent.Type.Resize)
        self._size, self._old = size or QSize(0, 0), old or QSize(0, 0)

    size = lambda self: self._size
    oldSize = lambda self: self._old


class QPaintEvent(QEvent):
    def __init__(self, *a):
        QEvent.__init__(self, QEvent.Type.Paint)

    rect = lambda self: QRect(0, 0, 0, 0)
    region = rect


class QCloseEvent(QEvent):
    def __init__(self):
        QEvent.__init__(self, QEvent.Type.Close)


class QShowEvent(QEvent):
    def __init__(self):
        QEvent.__init__(self, QEvent.Type.Show)


class QHideEvent(QEvent):
    def __init__(self):
        QEvent.__init__(self, QEvent.Type.Hide)


class QFocusEvent(QEvent):
    reason = lambda self: Qt.FocusReason.OtherFocusReason


class QMovie(QObject):
    frameChanged = Signal(int)

    def __init__(self, *a):
        super().__init__()

    start = stop = setScaledSize = setFileName = setCacheMode = setSpeed = jumpToFrame = lambda self, *a: None
    isValid = lambda self: False


class QRegion:
    def __init__(self, *a):
        pass


class QWindow(QObject):
    pass


class QDrag(QObject):
    def exec(self, *a):
        return Qt.DropAction.IgnoreAction

    exec_ = exec
    setMimeData = setPixmap = setHotSpot = lambda self, *a: None


class QPageSize:
    def __init__(self, *a):
        pass


class QPageLayout:
    def __init__(self, *a):
        pass


class QPdfWriter:
    def __init__(self, *a):
        pass

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


class QImageReader:
    def __init__(self, *a):
        pass

    @staticmethod
    def supportedImageFormats():
        return [b"png", b"jpg", b"svg"]

    read = lambda self: QImage()
    size = lambda self: QSize(0, 0)
    setScaledSize = setAutoTransform = lambda self, *a: None


class QImageWriter(QImageReader):
    write = lambda self, *a: False
