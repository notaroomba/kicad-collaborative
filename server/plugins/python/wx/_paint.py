# wx._paint — drawing.  A device context here is a list of drawing steps: a window that paints itself gets a
# <canvas> under its content and the steps are played on it (pyruntime.ts, __kcWx.paint); a bitmap drawn on through
# a MemoryDC keeps its steps and is rasterised when it is shown.  Without a browser (the test harness) the steps
# are kept, so a test can read what a plugin drew.

import json as _json
import math as _math
import weakref as _weakref

import wx as _wx

PENSTYLE_SOLID, PENSTYLE_DOT, PENSTYLE_LONG_DASH, PENSTYLE_SHORT_DASH, PENSTYLE_DOT_DASH, PENSTYLE_USER_DASH, PENSTYLE_TRANSPARENT = 100, 101, 102, 103, 104, 105, 106
BRUSHSTYLE_SOLID, BRUSHSTYLE_TRANSPARENT = 100, 106
_DASHES = {PENSTYLE_DOT: (1, 2), PENSTYLE_LONG_DASH: (6, 3), PENSTYLE_SHORT_DASH: (3, 3), PENSTYLE_DOT_DASH: (1, 3, 4, 3)}


def _css(c):
    if c is None:
        return None
    c = c if isinstance(c, _wx.Colour) else _wx.Colour(c)
    return c._css()


def _num(v):
    v = float(v)
    return int(v) if v == int(v) else round(v, 3)


def _flat(a):
    """Arguments given as numbers, points, sizes or rectangles, as one list of numbers."""
    out = []
    for v in a:
        if isinstance(v, _wx.Rect):
            out.extend((v.x, v.y, v.width, v.height))
        elif isinstance(v, (int, float)):
            out.append(v)
        elif v is None:
            continue
        else:
            try:
                out.extend(_flat(tuple(v)))
            except TypeError:
                pass
    return out


def _points(points, xoff=0, yoff=0):
    out = []
    for p in points:
        x, y = (p[0], p[1])
        out.extend((_num(x + xoff), _num(y + yoff)))
    return out


class Pen:
    def __init__(self, colour=None, width=1, style=PENSTYLE_SOLID):
        if isinstance(colour, Pen):
            colour, width, style = colour._colour, colour._width, colour._style
        elif isinstance(colour, PenInfo):
            colour, width, style = colour._colour, colour._width, colour._style
        self._colour = _wx.Colour(colour) if colour is not None else _wx.Colour(0, 0, 0)
        self._width = width if isinstance(width, (int, float)) else 1
        self._style = style if isinstance(style, int) and style else PENSTYLE_SOLID
        self._dashes = None
        self._cap = self._join = 0

    GetColour = lambda self: self._colour
    GetWidth = lambda self: self._width
    GetStyle = lambda self: self._style
    GetDashes = lambda self: list(self._dashes or [])
    GetCap = lambda self: self._cap
    GetJoin = lambda self: self._join
    IsOk = Ok = lambda self: True
    IsTransparent = lambda self: self._style == PENSTYLE_TRANSPARENT
    IsNonTransparent = lambda self: self._style != PENSTYLE_TRANSPARENT

    def SetColour(self, *c):
        self._colour = _wx.Colour(*c)

    def SetWidth(self, w):
        self._width = w

    def SetStyle(self, s):
        self._style = s

    def SetDashes(self, d):
        self._dashes = list(d)

    def SetCap(self, c):
        self._cap = c

    def SetJoin(self, j):
        self._join = j

    def _op(self):
        if self._style == PENSTYLE_TRANSPARENT:
            return ["pen", None, 0, []]
        w = max(1, self._width or 1)
        dash = self._dashes if self._style == PENSTYLE_USER_DASH and self._dashes else _DASHES.get(self._style, ())
        return ["pen", self._colour._css(), _num(w), [_num(d * w) for d in dash]]


class PenInfo:
    def __init__(self, colour=None, width=1, style=PENSTYLE_SOLID):
        self._colour, self._width, self._style = colour, width, style

    def Colour(self, c):
        self._colour = c
        return self

    def Width(self, w):
        self._width = w
        return self

    def Style(self, s):
        self._style = s
        return self

    Cap = Join = Dashes = Stipple = lambda self, *a: self


class Brush:
    def __init__(self, colour=None, style=BRUSHSTYLE_SOLID):
        if isinstance(colour, Brush):
            colour, style = colour._colour, colour._style
        self._colour = _wx.Colour(colour) if colour is not None else _wx.Colour(255, 255, 255)
        self._style = style if isinstance(style, int) and style else BRUSHSTYLE_SOLID

    GetColour = lambda self: self._colour
    GetStyle = lambda self: self._style
    IsOk = Ok = lambda self: True
    IsTransparent = lambda self: self._style == BRUSHSTYLE_TRANSPARENT
    IsNonTransparent = lambda self: self._style != BRUSHSTYLE_TRANSPARENT
    IsHatch = lambda self: False

    def SetColour(self, *c):
        self._colour = _wx.Colour(*c)

    def SetStyle(self, s):
        self._style = s

    def _op(self):
        return ["brush", None if self._style == BRUSHSTYLE_TRANSPARENT else self._colour._css()]


class _Gradient:
    """A gradient brush of a graphics context."""

    def __init__(self, kind, coords, stops):
        self._kind, self._coords, self._stops = kind, coords, stops

    def _op(self):
        return ["grad", self._kind, [_num(v) for v in self._coords], [[_num(o), _css(c)] for o, c in self._stops]]


def font_css(font):
    f = font if isinstance(font, _wx.Font) else _wx.NORMAL_FONT
    size = float(f._size or 10)
    px = size * 96.0 / 72.0
    family = "ui-monospace, Menlo, Consolas, monospace" if f._family in (_wx.FONTFAMILY_MODERN, _wx.FONTFAMILY_TELETYPE) else (
        '"%s", system-ui, sans-serif' % str(f._face).replace('"', "") if f._face else "system-ui, -apple-system, Segoe UI, sans-serif")
    weight = "700" if f._weight >= _wx.FONTWEIGHT_BOLD else "400"
    style = "italic " if f._wx_style in (_wx.FONTSTYLE_ITALIC, _wx.FONTSTYLE_SLANT) else ""
    return "%s%s %.2fpx %s" % (style, weight, px, family)


_measured = {}


def text_extent(text, font):
    """(width, height) of one line of text in a font, as the browser will draw it."""
    text = str(text)
    css = font_css(font)
    if _wx._DOM:
        key = (css, text)
        hit = _measured.get(key)
        if hit is None:
            try:
                m = _wx._kc().measure(text, css)
                hit = (float(m[0]), float(m[1]))
            except Exception:
                hit = None
            if hit is not None:
                if len(_measured) > 4000:
                    _measured.clear()
                _measured[key] = hit
        if hit is not None:
            return hit
    f = font if isinstance(font, _wx.Font) else _wx.NORMAL_FONT
    px = float(f._size or 10) * 96.0 / 72.0
    return (len(text) * px * 0.55, px * 1.25)


def bitmap_ops(bmp, x, y, w=None, h=None):
    """The steps that draw a bitmap at (x, y): its picture, and whatever was drawn on it."""
    if bmp is None or not isinstance(bmp, _wx.Bitmap):
        return []
    ops = []
    base = bmp._png if bmp._rgba is None else None
    if bmp._rgba is not None:
        if bmp._png is None:
            import base64
            bmp._png = "data:image/png;base64," + base64.b64encode(_wx._png_encode(bmp._w, bmp._h, bmp._rgba)).decode("ascii")
        base = bmp._png
    elif bmp._src:
        base = bmp._src
    sx = (w / bmp._w) if w is not None and bmp._w else 1
    sy = (h / bmp._h) if h is not None and bmp._h else 1
    if base:
        ops.append(["img", base, _num(x), _num(y), _num(bmp._w * sx), _num(bmp._h * sy)])
    if bmp._ops:
        ops.append(["save"])
        ops.append(["translate", _num(x), _num(y)])
        if sx != 1 or sy != 1:
            ops.append(["scale", _num(sx), _num(sy)])
        ops.extend(bmp._ops)
        ops.append(["restore"])
    return ops


def raster(bmp):
    """A bitmap that was drawn on, as a PNG address.  The browser draws it; without one the picture underneath stands."""
    if _wx._DOM:
        try:
            url = _wx._wait(_wx._kc().raster(int(bmp._w), int(bmp._h), _json.dumps(bitmap_ops(_BaseOnly(bmp), 0, 0) + list(bmp._ops))))
            return str(url)
        except Exception:
            pass
    if bmp._rgba is not None:
        import base64
        return "data:image/png;base64," + base64.b64encode(_wx._png_encode(bmp._w, bmp._h, bmp._rgba)).decode("ascii")
    return bmp._src


class _BaseOnly(_wx.Bitmap):
    def __init__(self, bmp):
        _wx.Bitmap.__init__(self)
        self._src, self._rgba, self._png, self._w, self._h, self._ops = bmp._src, bmp._rgba, bmp._png, bmp._w, bmp._h, None


# ----------------------------------------------------------------------------- device contexts

class DC:
    """Drawing on a window or on a bitmap."""
    _CLEARS = False            # a paint DC starts the window's picture anew

    def __init__(self, target=None, *more, **kw):
        self._ops = []
        self._win = None
        self._bmp = None
        self._done = False
        self._pen = BLACK_PEN
        self._brush = WHITE_BRUSH
        self._bg = WHITE_BRUSH
        self._font = _wx.NORMAL_FONT
        self._fg = _wx.Colour(0, 0, 0)
        self._tbg = None
        self._state = {}
        self._origin = (0, 0)
        buffer = kw.get("buffer")
        for m in more:
            if isinstance(m, _wx.Bitmap):
                buffer = m
        if isinstance(target, DC):                     # GCDC(dc), BufferedDC(dc, bitmap)
            self._inner = target
            self._win, self._bmp = target._win, target._bmp
            self._ops = target._ops
        elif isinstance(target, _wx.Window):
            self._win = target
            self._font = target.GetFont() or _wx.NORMAL_FONT
            live = target.__dict__.setdefault("_wx_live_dcs", [])
            live.append(_weakref.ref(self))
        elif isinstance(target, _wx.Bitmap):
            self.SelectObject(target)
        elif isinstance(target, GraphicsContext):
            self._win, self._bmp, self._ops = target._win, target._bmp, target._ops
        if buffer is not None and self._bmp is None and self._win is None:
            self.SelectObject(buffer)

    # -- where the steps go
    def _emit(self, op):
        self._ops.append(op)

    def _flush(self):
        if self._done:
            return
        self._done = True
        if self._win is not None and not hasattr(self, "_inner"):
            _deliver(self._win, self._ops, self._CLEARS)

    def __del__(self):
        try:
            self._flush()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self._flush()
        return False

    Destroy = lambda self: self._flush()
    UnMask = Flush = lambda self: None
    IsOk = Ok = lambda self: True
    CanDrawBitmap = CanGetTextExtent = lambda self: True
    StartDoc = lambda self, *a: True
    EndDoc = StartPage = EndPage = BeginDrawing = EndDrawing = lambda self, *a: None
    SetLogicalFunction = SetMapMode = SetAxisOrientation = SetLayoutDirection = SetPalette = lambda self, *a: None
    GetLogicalFunction = lambda self: 0
    GetPPI = lambda self: _wx.Size(96, 96)
    GetContentScaleFactor = GetDPIScaleFactor = lambda self: 1.0
    FromDIP = ToDIP = lambda self, v, *_: v
    GetDepth = lambda self: 32

    def SelectObject(self, bmp):
        self._bmp = bmp if isinstance(bmp, _wx.Bitmap) and bmp is not _wx.NullBitmap else None
        if self._bmp is not None:
            if self._bmp._ops is None:
                self._bmp._ops = []
            self._bmp._png = None if self._bmp._rgba is None else self._bmp._png
            self._ops = self._bmp._ops
        else:
            self._ops = []

    SelectObjectAsSource = SelectObject

    def GetAsBitmap(self, *_):
        if self._bmp is not None:
            return _wx.Bitmap(self._bmp)
        w, h = self.GetSize()
        b = _wx.Bitmap(int(w), int(h))
        b._ops = list(self._ops)
        return b

    def GetSize(self):
        if self._bmp is not None:
            return _wx.Size(self._bmp._w, self._bmp._h)
        if self._win is not None:
            return self._win.GetClientSize()
        return _wx.Size(100, 100)

    GetSizeTuple = lambda self: tuple(self.GetSize())
    GetWindow = lambda self: self._win

    # -- tools
    def _set(self, key, op):
        """A tool is named in the steps once, when it changes."""
        k = _json.dumps(op)
        if self._state.get(key) != k:
            self._state[key] = k
            self._emit(op)

    def SetPen(self, pen):
        self._pen = pen if isinstance(pen, Pen) else TRANSPARENT_PEN
        self._set("pen", self._pen._op())

    def SetBrush(self, brush):
        self._brush = brush if isinstance(brush, (Brush, _Gradient)) else TRANSPARENT_BRUSH
        self._set("brush", self._brush._op())

    def SetFont(self, font, *_):
        if isinstance(font, _wx.Font):
            self._font = font
            self._set("font", ["font", font_css(font)])

    def SetTextForeground(self, c):
        self._fg = _wx.Colour(c)
        self._set("tfg", ["tfg", self._fg._css()])

    def SetTextBackground(self, c):
        self._tbg = _wx.Colour(c) if c is not None else None

    def SetBackground(self, brush):
        self._bg = brush if isinstance(brush, Brush) else WHITE_BRUSH

    def SetBackgroundMode(self, *_):
        pass

    GetPen = lambda self: self._pen
    GetBrush = lambda self: self._brush
    GetFont = lambda self: self._font
    GetBackground = lambda self: self._bg
    GetTextForeground = lambda self: self._fg
    GetTextBackground = lambda self: self._tbg or _wx.Colour(255, 255, 255)
    GetBackgroundMode = lambda self: _wx.TRANSPARENT

    def _tools(self):
        if "pen" not in self._state:
            self._set("pen", self._pen._op())
        if "brush" not in self._state:
            self._set("brush", self._brush._op())

    def _text_tools(self):
        if "font" not in self._state:
            self._set("font", ["font", font_css(self._font)])
        if "tfg" not in self._state:
            self._set("tfg", ["tfg", self._fg._css()])

    # -- measuring
    def GetTextExtent(self, text):
        lines = str(text).split("\n")
        w = max(text_extent(l, self._font)[0] for l in lines)
        h = text_extent("Ag", self._font)[1] * len(lines)
        return _wx.Size(int(_math.ceil(w)), int(_math.ceil(h)))

    GetMultiLineTextExtent = GetTextExtent

    def GetFullTextExtent(self, text, *_):
        s = self.GetTextExtent(text)
        return (s.x, s.y, int(s.y * 0.2), 0)

    def GetPartialTextExtents(self, text):
        return [int(_math.ceil(text_extent(str(text)[:i + 1], self._font)[0])) for i in range(len(str(text)))]

    GetCharHeight = lambda self: self.GetTextExtent("Ag").y
    GetCharWidth = lambda self: self.GetTextExtent("x").x

    def GetFontMetrics(self):
        h = self.GetTextExtent("Ag").y
        return type("FontMetrics", (), {"height": h, "ascent": int(h * 0.8), "descent": int(h * 0.2), "internalLeading": 0, "externalLeading": 0,
                                        "averageWidth": self.GetTextExtent("x").x})()

    # -- drawing
    def Clear(self):
        self._emit(["clear", self._bg._colour._css() if self._bg._style != BRUSHSTYLE_TRANSPARENT else None])

    def DrawLine(self, *a):
        x1, y1, x2, y2 = _flat(a)[:4]
        self._tools()
        self._emit(["line", _num(x1), _num(y1), _num(x2), _num(y2)])

    def DrawLines(self, points, xoffset=0, yoffset=0):
        self._tools()
        self._emit(["lines", _points(points, xoffset, yoffset)])

    def DrawPolygon(self, points, xoffset=0, yoffset=0, fillStyle=0):
        self._tools()
        self._emit(["poly", _points(points, xoffset, yoffset)])

    def DrawSpline(self, *a):
        pts = a[0] if len(a) == 1 else [(a[0], a[1]), (a[2], a[3]), (a[4], a[5])]
        self.DrawLines(pts)

    def DrawPoint(self, *a):
        x, y = _flat(a)[:2]
        self._tools()
        self._emit(["point", _num(x), _num(y)])

    def DrawRectangle(self, *a):
        x, y, w, h = _flat(a)[:4]
        self._tools()
        self._emit(["rect", _num(x), _num(y), _num(w), _num(h)])

    def DrawRoundedRectangle(self, *a):
        v = _flat(a)
        x, y, w, h = v[:4]
        r = v[4] if len(v) > 4 else 0
        if r < 0:
            r = -r * min(w, h)
        self._tools()
        self._emit(["rrect", _num(x), _num(y), _num(w), _num(h), _num(r)])

    def DrawCircle(self, *a):
        x, y, r = _flat(a)[:3]
        self._tools()
        self._emit(["ellipse", _num(x - r), _num(y - r), _num(2 * r), _num(2 * r)])

    def DrawEllipse(self, *a):
        x, y, w, h = _flat(a)[:4]
        self._tools()
        self._emit(["ellipse", _num(x), _num(y), _num(w), _num(h)])

    def DrawArc(self, *a):
        x1, y1, x2, y2, xc, yc = _flat(a)[:6]
        r = _math.hypot(x1 - xc, y1 - yc)
        self._tools()
        # counter-clockwise on the screen from the first point to the second, closed to the centre when filled
        self._emit(["arc", _num(xc), _num(yc), _num(r), _num(_math.atan2(y1 - yc, x1 - xc)), _num(_math.atan2(y2 - yc, x2 - xc)), 1, 1])

    def DrawEllipticArc(self, *a):
        x, y, w, h, start, end = _flat(a)[:6]
        self._tools()
        self._emit(["earc", _num(x), _num(y), _num(w), _num(h), _num(-_math.radians(start)), _num(-_math.radians(end))])

    def DrawText(self, text, *a):
        x, y = _flat(a)[:2]
        self._text_tools()
        self._emit(["text", str(text), _num(x), _num(y), self._tbg._css() if self._tbg is not None and False else None])

    def DrawRotatedText(self, text, *a):
        v = _flat(a)
        x, y = v[:2]
        angle = v[2] if len(v) > 2 else 0
        self._text_tools()
        self._emit(["rtext", str(text), _num(x), _num(y), _num(-_math.radians(angle))])

    def DrawLabel(self, text, *a, **k):
        rect = next((v for v in a if isinstance(v, _wx.Rect)), None)
        bitmap = next((v for v in a if isinstance(v, _wx.Bitmap)), None)
        align = k.get("alignment", next((v for v in a if isinstance(v, int)), _wx.ALIGN_LEFT | _wx.ALIGN_TOP))
        if rect is None:
            return
        w, h = self.GetTextExtent(text)
        x, y = rect.x, rect.y
        if align & _wx.ALIGN_CENTER_HORIZONTAL:
            x += (rect.width - w) / 2
        elif align & _wx.ALIGN_RIGHT:
            x += rect.width - w
        if align & _wx.ALIGN_CENTER_VERTICAL:
            y += (rect.height - h) / 2
        elif align & _wx.ALIGN_BOTTOM:
            y += rect.height - h
        if bitmap is not None:
            self.DrawBitmap(bitmap, rect.x, rect.y)
        self.DrawText(text, x, y)

    def DrawBitmap(self, bmp, *a):
        v = _flat(a)
        x, y = (v + [0, 0])[:2]
        for op in bitmap_ops(bmp, x, y):
            self._emit(op)

    DrawIcon = DrawBitmap

    def Blit(self, xdest, ydest, width, height, source, xsrc=0, ysrc=0, *_):
        bmp = source._bmp if isinstance(source, DC) else source
        if bmp is None and isinstance(source, DC):
            self._emit(["save"])
            self._emit(["clip", _num(xdest), _num(ydest), _num(width), _num(height)])
            self._emit(["translate", _num(xdest - xsrc), _num(ydest - ysrc)])
            for op in source._ops:
                self._emit(op)
            self._emit(["restore"])
            self._state.clear()
            return True
        self._emit(["save"])
        self._emit(["clip", _num(xdest), _num(ydest), _num(width), _num(height)])
        for op in bitmap_ops(bmp, xdest - xsrc, ydest - ysrc):
            self._emit(op)
        self._emit(["restore"])
        self._state.clear()
        return True

    def StretchBlit(self, xdest, ydest, dstWidth, dstHeight, source, xsrc=0, ysrc=0, srcWidth=None, srcHeight=None, *_):
        bmp = source._bmp if isinstance(source, DC) else source
        if isinstance(bmp, _wx.Bitmap):
            sw, sh = srcWidth or bmp._w, srcHeight or bmp._h
            kx, ky = dstWidth / float(sw or 1), dstHeight / float(sh or 1)
            self._emit(["save"])
            self._emit(["clip", _num(xdest), _num(ydest), _num(dstWidth), _num(dstHeight)])
            for op in bitmap_ops(bmp, xdest - xsrc * kx, ydest - ysrc * ky, bmp._w * kx, bmp._h * ky):
                self._emit(op)
            self._emit(["restore"])
            self._state.clear()
        return True

    def GradientFillLinear(self, rect, c1, c2, direction=None):
        x, y, w, h = _flat([rect])[:4]
        d = direction if direction is not None else _wx.EAST
        x1, y1, x2, y2 = (x, y, x + w, y) if d == _wx.EAST else ((x + w, y, x, y) if d == _wx.WEST else ((x, y, x, y + h) if d == _wx.SOUTH else (x, y + h, x, y)))
        self._emit(["save"])
        self._emit(["pen", None, 0, []])
        self._emit(["grad", "linear", [_num(x1), _num(y1), _num(x2), _num(y2)], [[0, _css(c1)], [1, _css(c2)]]])
        self._emit(["rect", _num(x), _num(y), _num(w), _num(h)])
        self._emit(["restore"])
        self._state.clear()

    def GradientFillConcentric(self, rect, c1, c2, *_):
        x, y, w, h = _flat([rect])[:4]
        self._emit(["save"])
        self._emit(["pen", None, 0, []])
        self._emit(["grad", "radial", [_num(x + w / 2), _num(y + h / 2), 0, _num(x + w / 2), _num(y + h / 2), _num(max(w, h) / 2)], [[0, _css(c1)], [1, _css(c2)]]])
        self._emit(["rect", _num(x), _num(y), _num(w), _num(h)])
        self._emit(["restore"])
        self._state.clear()

    def CrossHair(self, *a):
        x, y = _flat(a)[:2]
        w, h = self.GetSize()
        self.DrawLine(0, y, w, y)
        self.DrawLine(x, 0, x, h)

    def DrawCheckMark(self, *a):
        x, y, w, h = _flat(a)[:4]
        self.DrawLines([(x, y + h / 2), (x + w / 3, y + h), (x + w, y)])

    def FloodFill(self, *a):
        return False

    def DrawLineList(self, lines, pens=None):
        for i, l in enumerate(lines):
            if isinstance(pens, (list, tuple)):
                self.SetPen(pens[i])
            elif isinstance(pens, Pen) and i == 0:
                self.SetPen(pens)
            self.DrawLine(*l)

    def DrawPointList(self, points, pens=None):
        for i, p in enumerate(points):
            if isinstance(pens, (list, tuple)):
                self.SetPen(pens[i])
            elif isinstance(pens, Pen) and i == 0:
                self.SetPen(pens)
            self.DrawPoint(*p)

    def _shape_list(self, draw, shapes, pens, brushes):
        for i, s in enumerate(shapes):
            if isinstance(pens, (list, tuple)):
                self.SetPen(pens[i])
            elif isinstance(pens, Pen) and i == 0:
                self.SetPen(pens)
            if isinstance(brushes, (list, tuple)):
                self.SetBrush(brushes[i])
            elif isinstance(brushes, Brush) and i == 0:
                self.SetBrush(brushes)
            draw(*s) if not isinstance(s, _wx.Rect) else draw(s)

    def DrawRectangleList(self, rects, pens=None, brushes=None):
        self._shape_list(self.DrawRectangle, rects, pens, brushes)

    def DrawEllipseList(self, ellipses, pens=None, brushes=None):
        self._shape_list(self.DrawEllipse, ellipses, pens, brushes)

    def DrawPolygonList(self, polygons, pens=None, brushes=None):
        self._shape_list(lambda *p: self.DrawPolygon(list(p)), polygons, pens, brushes)

    def DrawTextList(self, texts, coords, foregrounds=None, backgrounds=None):
        if isinstance(texts, str):
            texts = [texts] * len(coords)
        for i, t in enumerate(texts):
            if isinstance(foregrounds, (list, tuple)):
                self.SetTextForeground(foregrounds[i])
            elif foregrounds is not None and i == 0:
                self.SetTextForeground(foregrounds)
            self.DrawText(t, *coords[i])

    # -- the coordinate system
    def SetClippingRegion(self, *a):
        x, y, w, h = _flat(a)[:4]
        self._emit(["save"])
        self._emit(["clip", _num(x), _num(y), _num(w), _num(h)])
        self._clipped = getattr(self, "_clipped", 0) + 1

    SetClippingRect = SetDeviceClippingRegion = SetClippingRegion

    def DestroyClippingRegion(self):
        while getattr(self, "_clipped", 0) > 0:
            self._emit(["restore"])
            self._clipped -= 1
        self._state.clear()

    def GetClippingRect(self):
        w, h = self.GetSize()
        return _wx.Rect(0, 0, w, h)

    GetClippingBox = lambda self: tuple(self.GetClippingRect().Get())

    def SetDeviceOrigin(self, x, y):
        ox, oy = self._origin
        self._emit(["translate", _num(x - ox), _num(y - oy)])
        self._origin = (x, y)

    SetLogicalOrigin = lambda self, x, y: self.SetDeviceOrigin(-x, -y)
    GetDeviceOrigin = lambda self: _wx.Point(*self._origin)

    def SetUserScale(self, sx, sy):
        px, py = getattr(self, "_scale", (1.0, 1.0))
        if sx and sy:
            self._emit(["scale", _num(sx / px), _num(sy / py)])
            self._scale = (sx, sy)

    SetLogicalScale = SetUserScale
    GetUserScale = lambda self: getattr(self, "_scale", (1.0, 1.0))
    DeviceToLogicalX = DeviceToLogicalY = LogicalToDeviceX = LogicalToDeviceY = DeviceToLogicalXRel = DeviceToLogicalYRel = LogicalToDeviceXRel = LogicalToDeviceYRel = lambda self, v: v

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        _wx._missing.add("DC." + name)
        return lambda *a, **k: None


class PaintDC(DC):
    _CLEARS = True


class BufferedPaintDC(PaintDC):
    pass


class AutoBufferedPaintDC(PaintDC):
    pass


class ClientDC(DC):
    pass


class WindowDC(DC):
    pass


class ScreenDC(DC):
    pass


class MemoryDC(DC):
    pass


class BufferedDC(DC):
    def __init__(self, dc=None, buffer=None, *more, **kw):
        if isinstance(dc, DC) and isinstance(buffer, _wx.Bitmap):
            DC.__init__(self, buffer)
            self._onto = dc
        elif isinstance(dc, DC):
            DC.__init__(self, dc)
        elif isinstance(buffer, _wx.Bitmap):
            DC.__init__(self, buffer)
        else:
            DC.__init__(self, dc, *more, **kw)

    def _flush(self):
        onto = getattr(self, "_onto", None)
        if onto is not None and not self._done and self._bmp is not None:
            onto.DrawBitmap(self._bmp, 0, 0)
            onto._flush()
        DC._flush(self)


class GCDC(DC):
    def GetGraphicsContext(self):
        return GraphicsContext(self)


def AutoBufferedPaintDCFactory(window):
    return AutoBufferedPaintDC(window)


# ----------------------------------------------------------------------------- graphics contexts

class GraphicsPath:
    def __init__(self):
        self._c = []
        self._cur = (0.0, 0.0)
        self._box = None

    def _see(self, x, y):
        b = self._box
        self._box = (x, y, x, y) if b is None else (min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y))

    def MoveToPoint(self, *a):
        x, y = _flat(a)[:2]
        self._c.extend(("M", _num(x), _num(y)))
        self._cur = (x, y)
        self._see(x, y)

    def AddLineToPoint(self, *a):
        x, y = _flat(a)[:2]
        self._c.extend(("L", _num(x), _num(y)))
        self._cur = (x, y)
        self._see(x, y)

    def AddCurveToPoint(self, *a):
        v = _flat(a)[:6]
        self._c.extend(["C"] + [_num(n) for n in v])
        self._cur = (v[4], v[5])
        for i in (0, 2, 4):
            self._see(v[i], v[i + 1])

    def AddQuadCurveToPoint(self, *a):
        v = _flat(a)[:4]
        self._c.extend(["Q"] + [_num(n) for n in v])
        self._cur = (v[2], v[3])
        for i in (0, 2):
            self._see(v[i], v[i + 1])

    def AddArc(self, *a):
        v = _flat(a)
        x, y, r, start, end = v[:5]
        clockwise = bool(v[5]) if len(v) > 5 else True
        self._c.extend(("A", _num(x), _num(y), _num(r), _num(start), _num(end), 0 if clockwise else 1))
        self._cur = (x + r * _math.cos(end), y + r * _math.sin(end))
        self._see(x - r, y - r)
        self._see(x + r, y + r)

    def AddArcToPoint(self, x1, y1, x2, y2, r):
        self._c.extend(("T", _num(x1), _num(y1), _num(x2), _num(y2), _num(r)))
        self._cur = (x2, y2)
        self._see(x1, y1)
        self._see(x2, y2)

    def AddCircle(self, x, y, r):
        self._c.extend(("M", _num(x + r), _num(y), "A", _num(x), _num(y), _num(r), 0, _num(2 * _math.pi), 0, "Z"))
        self._see(x - r, y - r)
        self._see(x + r, y + r)

    def AddEllipse(self, x, y, w, h):
        self._c.extend(("E", _num(x), _num(y), _num(w), _num(h)))
        self._see(x, y)
        self._see(x + w, y + h)

    def AddRectangle(self, x, y, w, h):
        self._c.extend(("R", _num(x), _num(y), _num(w), _num(h)))
        self._see(x, y)
        self._see(x + w, y + h)

    def AddRoundedRectangle(self, x, y, w, h, r):
        self._c.extend(("O", _num(x), _num(y), _num(w), _num(h), _num(r)))
        self._see(x, y)
        self._see(x + w, y + h)

    def AddPath(self, other):
        self._c.extend(other._c)
        if other._box:
            self._see(other._box[0], other._box[1])
            self._see(other._box[2], other._box[3])

    def CloseSubpath(self):
        self._c.append("Z")

    def GetCurrentPoint(self):
        return _wx.Point(*self._cur)

    def GetBox(self):
        b = self._box or (0, 0, 0, 0)
        return (b[0], b[1], b[2] - b[0], b[3] - b[1])

    def Contains(self, *a):
        x, y = _flat(a)[:2]
        b = self._box
        return b is not None and b[0] <= x <= b[2] and b[1] <= y <= b[3]

    Transform = UnGetNativePath = lambda self, *a: None


class _GraphicsFont:
    def __init__(self, font, colour):
        self._font, self._colour = font, colour


class GraphicsContext:
    """wx.GraphicsContext: paths, transforms and anti-aliased drawing, on the same steps as a DC."""

    def __init__(self, target=None):
        self._win = self._bmp = None
        self._ops = []
        self._dc = None
        if isinstance(target, DC):
            self._dc = target
            self._win, self._bmp, self._ops = target._win, target._bmp, target._ops
            target._state.clear()
        elif isinstance(target, _wx.Window):
            self._dc = ClientDC(target)
            self._win, self._ops = target, self._dc._ops
        elif isinstance(target, _wx.Bitmap):
            self._dc = MemoryDC(target)
            self._bmp, self._ops = target, self._dc._ops
        self._pen = TRANSPARENT_PEN
        self._brush = TRANSPARENT_BRUSH
        self._font = _wx.NORMAL_FONT
        self._fg = _wx.Colour(0, 0, 0)
        self._state = {}

    @staticmethod
    def Create(target=None, *_):
        return GraphicsContext(target)

    CreateFromUnscaledDPI = Create

    def _emit(self, op):
        self._ops.append(op)

    def _set(self, key, op):
        k = _json.dumps(op)
        if self._state.get(key) != k:
            self._state[key] = k
            self._emit(op)

    def _tools(self):
        self._set("pen", self._pen._op())
        self._set("brush", self._brush._op())

    # -- tools
    def SetPen(self, pen, *_):
        self._pen = pen if isinstance(pen, Pen) else TRANSPARENT_PEN

    def SetBrush(self, brush):
        self._brush = brush if isinstance(brush, (Brush, _Gradient)) else TRANSPARENT_BRUSH

    def SetFont(self, font, colour=None):
        if isinstance(font, _GraphicsFont):
            font, colour = font._font, font._colour
        if isinstance(font, _wx.Font):
            self._font = font
        if colour is not None:
            self._fg = _wx.Colour(colour)

    CreatePen = lambda self, pen, *_: Pen(pen) if isinstance(pen, (Pen, PenInfo)) else TRANSPARENT_PEN
    CreateBrush = lambda self, brush: brush
    CreateFont = lambda self, font, colour=None, *_: _GraphicsFont(font if isinstance(font, _wx.Font) else _wx.NORMAL_FONT, colour if colour is not None else _wx.Colour(0, 0, 0))
    CreatePath = lambda self: GraphicsPath()
    CreateBitmap = lambda self, bmp: bmp
    CreateBitmapFromImage = lambda self, img: _wx.Bitmap(img)
    CreateMatrix = lambda self, *a: None

    def CreateLinearGradientBrush(self, x1, y1, x2, y2, c1, c2=None, *_):
        stops = [(0, c1), (1, c2)] if c2 is not None and not hasattr(c1, "_stops") else getattr(c1, "_stops", [(0, c1), (1, c1)])
        return _Gradient("linear", (x1, y1, x2, y2), stops)

    def CreateRadialGradientBrush(self, xo, yo, xc, yc, radius, c1, c2=None, *_):
        stops = [(0, c1), (1, c2)] if c2 is not None and not hasattr(c1, "_stops") else getattr(c1, "_stops", [(0, c1), (1, c1)])
        return _Gradient("radial", (xo, yo, 0, xc, yc, radius), stops)

    # -- state
    def PushState(self):
        self._emit(["save"])

    def PopState(self):
        self._emit(["restore"])
        self._state.clear()

    def Translate(self, dx, dy):
        self._emit(["translate", _num(dx), _num(dy)])

    def Scale(self, sx, sy):
        self._emit(["scale", _num(sx), _num(sy)])

    def Rotate(self, angle):
        self._emit(["rotate", _num(angle)])

    def Clip(self, *a):
        x, y, w, h = _flat(a)[:4]
        self._emit(["clip", _num(x), _num(y), _num(w), _num(h)])

    def ResetClip(self):
        self._emit(["unclip"])

    def BeginLayer(self, opacity):
        self._emit(["save"])
        self._emit(["alpha", _num(opacity)])

    def EndLayer(self):
        self._emit(["restore"])
        self._state.clear()

    SetAntialiasMode = SetInterpolationQuality = SetCompositionMode = EnableOffset = DisableOffset = SetTransform = ConcatTransform = lambda self, *a: True
    GetAntialiasMode = GetInterpolationQuality = GetCompositionMode = lambda self: 0
    Flush = lambda self: None
    StartDoc = StartPage = EndDoc = EndPage = lambda self, *a: True
    GetDPI = lambda self: (96.0, 96.0)
    GetWindow = lambda self: self._win
    FromDIP = ToDIP = lambda self, v, *_: v
    GetContentScaleFactor = lambda self: 1.0

    def GetSize(self):
        if self._bmp is not None:
            return (float(self._bmp._w), float(self._bmp._h))
        if self._win is not None:
            w, h = self._win.GetClientSize()
            return (float(w), float(h))
        return (100.0, 100.0)

    # -- drawing
    def _path(self, path, mode):
        self._tools()
        self._emit(["path", list(path._c), mode])

    def StrokePath(self, path):
        self._path(path, 0)

    def FillPath(self, path, *_):
        self._path(path, 1)

    def DrawPath(self, path, *_):
        self._path(path, 2)

    def DrawRectangle(self, x, y, w, h):
        self._tools()
        self._emit(["rect", _num(x), _num(y), _num(w), _num(h)])

    def DrawRoundedRectangle(self, x, y, w, h, r):
        self._tools()
        self._emit(["rrect", _num(x), _num(y), _num(w), _num(h), _num(r)])

    def DrawEllipse(self, x, y, w, h):
        self._tools()
        self._emit(["ellipse", _num(x), _num(y), _num(w), _num(h)])

    def StrokeLine(self, x1, y1, x2, y2):
        self._tools()
        self._emit(["line", _num(x1), _num(y1), _num(x2), _num(y2)])

    def StrokeLines(self, points, *more):
        self._tools()
        if more:                                    # StrokeLines(begin points, end points): separate segments
            for p, q in zip(points, more[0]):
                self._emit(["line", _num(p[0]), _num(p[1]), _num(q[0]), _num(q[1])])
            return
        self._emit(["lines", _points(points)])

    def DrawLines(self, points, *_):
        self._tools()
        self._emit(["poly", _points(points)])

    StrokeLineSegments = lambda self, a, b: self.StrokeLines(a, b)

    def DrawText(self, text, x, y, *more):
        self._set("font", ["font", font_css(self._font)])
        self._set("tfg", ["tfg", self._fg._css()])
        angle = next((m for m in more if isinstance(m, (int, float))), 0)
        if angle:
            self._emit(["rtext", str(text), _num(x), _num(y), _num(-angle)])
        else:
            self._emit(["text", str(text), _num(x), _num(y), None])

    DrawRotatedText = lambda self, text, x, y, angle, *_: self.DrawText(text, x, y, angle)

    def DrawBitmap(self, bmp, x, y, w=None, h=None):
        for op in bitmap_ops(bmp, x, y, w, h):
            self._emit(op)

    DrawIcon = DrawBitmap

    def GetTextExtent(self, text):
        lines = str(text).split("\n")
        return (max(text_extent(l, self._font)[0] for l in lines), text_extent("Ag", self._font)[1] * len(lines))

    def GetFullTextExtent(self, text):
        w, h = self.GetTextExtent(text)
        return (w, h, h * 0.2, 0.0)

    def GetPartialTextExtents(self, text):
        return [text_extent(str(text)[:i + 1], self._font)[0] for i in range(len(str(text)))]

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        _wx._missing.add("GraphicsContext." + name)
        return lambda *a, **k: None


class GraphicsRenderer:
    GetDefaultRenderer = GetCairoRenderer = GetDirect2DRenderer = GetGDIPlusRenderer = staticmethod(lambda: GraphicsRenderer())
    CreateContext = CreateContextFromImage = CreateMeasuringContext = lambda self, target=None, *_: GraphicsContext(target)
    GetName = lambda self: "canvas"


class GraphicsGradientStops:
    def __init__(self, start=None, end=None):
        self._stops = []
        if start is not None:
            self._stops.append((0, start))
        if end is not None:
            self._stops.append((1, end))

    def Add(self, colour, pos=None):
        if pos is None and hasattr(colour, "GetPosition"):
            colour, pos = colour.GetColour(), colour.GetPosition()
        self._stops.append((pos, colour))
        self._stops.sort(key=lambda s: s[0])

    GetCount = lambda self: len(self._stops)


BLACK_PEN, WHITE_PEN, RED_PEN, GREEN_PEN, BLUE_PEN, CYAN_PEN, GREY_PEN, MEDIUM_GREY_PEN, LIGHT_GREY_PEN = (
    Pen(_wx.Colour(0, 0, 0)), Pen(_wx.Colour(255, 255, 255)), Pen(_wx.Colour(255, 0, 0)), Pen(_wx.Colour(0, 128, 0)), Pen(_wx.Colour(0, 0, 255)),
    Pen(_wx.Colour(0, 255, 255)), Pen(_wx.Colour(128, 128, 128)), Pen(_wx.Colour(160, 160, 160)), Pen(_wx.Colour(211, 211, 211)))
TRANSPARENT_PEN = NullPen = NullGraphicsPen = Pen(_wx.Colour(0, 0, 0), 1, PENSTYLE_TRANSPARENT)
BLACK_BRUSH, WHITE_BRUSH, RED_BRUSH, GREEN_BRUSH, BLUE_BRUSH, CYAN_BRUSH, GREY_BRUSH, MEDIUM_GREY_BRUSH, LIGHT_GREY_BRUSH = (
    Brush(_wx.Colour(0, 0, 0)), Brush(_wx.Colour(255, 255, 255)), Brush(_wx.Colour(255, 0, 0)), Brush(_wx.Colour(0, 128, 0)), Brush(_wx.Colour(0, 0, 255)),
    Brush(_wx.Colour(0, 255, 255)), Brush(_wx.Colour(128, 128, 128)), Brush(_wx.Colour(160, 160, 160)), Brush(_wx.Colour(211, 211, 211)))
TRANSPARENT_BRUSH = NullBrush = NullGraphicsBrush = Brush(_wx.Colour(0, 0, 0), BRUSHSTYLE_TRANSPARENT)


class _PenList:
    FindOrCreatePen = staticmethod(lambda colour, width=1, style=PENSTYLE_SOLID: Pen(colour, width, style))


class _BrushList:
    FindOrCreateBrush = staticmethod(lambda colour, style=BRUSHSTYLE_SOLID: Brush(colour, style))


ThePenList, TheBrushList = _PenList(), _BrushList()


# ----------------------------------------------------------------------------- windows that paint themselves

def _deliver(win, ops, clear):
    """Play drawing steps on a window's canvas (or keep them, where there is none)."""
    win.__dict__["_wx_last_ops"] = list(ops) if clear else list(win.__dict__.get("_wx_last_ops", [])) + list(ops)
    if not _wx._DOM or getattr(win, "_wx_destroyed", False):
        return
    canvas = _canvas(win)
    if canvas is None:
        return
    w, h = win._wx_box()
    try:
        _wx._kc().paint(canvas, _json.dumps(ops), int(w), int(h), bool(clear))
    except Exception:
        pass


def _canvas(win):
    c = win.__dict__.get("_wx_canvas")
    if c is None:
        if str(getattr(win.el, "tagName", "DIV")).upper() not in ("DIV", "FIELDSET", "SPAN", "SECTION", "BUTTON", "LABEL"):
            return None          # an element that cannot hold a canvas (an input, an image)
        c = _wx._el("canvas", "wx-canvas")
        el = win.el
        el.classList.add("wx-painted")
        first = el.firstChild if _wx._DOM else None
        if first is not None:
            el.insertBefore(c, first)
        else:
            el.appendChild(c)
        win.__dict__["_wx_canvas"] = c
    return c


def _best_size(win):
    """A control that draws itself says how big it wants to be (DoGetBestSize); the layout is told."""
    if win.__dict__.get("_wx_best_done") or win.__dict__.get("_wx_min") is not None:
        return
    win.__dict__["_wx_best_done"] = True
    fn = getattr(type(win), "DoGetBestSize", None) or getattr(type(win), "DoGetBestClientSize", None)
    if fn is None:
        return
    try:
        size = fn(win)
        w, h = int(size[0]), int(size[1])
    except Exception:
        return
    if w > 0 or h > 0:
        _wx.Window.SetMinSize(win, (w, h))
        win.__dict__["_wx_min"] = None             # still the control's own wish, asked again when it says it changed


def paint_now(win):
    """Have a window paint itself: its EVT_PAINT handlers run and what they draw goes to its canvas."""
    d = win.__dict__
    d["_wx_paint_due"] = False
    if d.get("_wx_painting") or getattr(win, "_wx_destroyed", False):
        return
    if not any(h[0] is _wx.EVT_PAINT for h in win._wx_handlers):
        return
    d["_wx_painting"] = True
    d["_wx_live_dcs"] = []
    try:
        ev = _wx.Event(win, _wx.EVT_PAINT)
        win._wx_fire(_wx.EVT_PAINT, ev)
        flushed = False
        for ref in list(d.get("_wx_live_dcs", [])):
            dc = ref()
            if dc is not None:
                flushed = flushed or dc._done or True
                dc._flush()
        d["_wx_live_dcs"] = []
    finally:
        d["_wx_painting"] = False


def schedule_paint(win):
    d = win.__dict__
    if d.get("_wx_paint_due") or d.get("_wx_painting"):
        return
    if not any(h[0] is _wx.EVT_PAINT for h in win._wx_handlers):
        return
    _best_size(win)
    if _wx._DOM:
        d["_wx_paint_due"] = True
        _wx._kc().later(_wx._once(lambda: _wx._call(paint_now, win)), 0)
    else:
        paint_now(win)


_MOUSE = {}          # DOM event -> [(binder, button or None)]


def _mouse_table():
    if not _MOUSE:
        w = _wx
        _MOUSE.update({
            "mousedown": [(w.EVT_LEFT_DOWN, 0), (w.EVT_MIDDLE_DOWN, 1), (w.EVT_RIGHT_DOWN, 2)],
            "mouseup": [(w.EVT_LEFT_UP, 0), (w.EVT_MIDDLE_UP, 1), (w.EVT_RIGHT_UP, 2)],
            "dblclick": [(w.EVT_LEFT_DCLICK, 0)],
            "mousemove": [(w.EVT_MOTION, None)],
            "mouseenter": [(w.EVT_ENTER_WINDOW, None)],
            "mouseleave": [(w.EVT_LEAVE_WINDOW, None)],
            "wheel": [(w.EVT_MOUSEWHEEL, None)],
            "contextmenu": [(w.EVT_CONTEXT_MENU, None)],
        })
    return _MOUSE


class MouseEvent(_wx.Event):
    """A mouse event of a window, with where the pointer is inside it."""

    def __init__(self, source=None, binder=None, dom=None, kind=""):
        _wx.Event.__init__(self, source, binder)
        self._kind = kind
        self._x = self._y = 0
        self._button, self._buttons, self._wheel = -1, 0, 0
        self._ctrl = self._shift = self._alt = self._meta = False
        if dom is not None and source is not None:
            try:
                r = source.el.getBoundingClientRect()
                self._x, self._y = int(dom.clientX - r.left), int(dom.clientY - r.top)
                self._button, self._buttons = int(dom.button), int(dom.buttons)
                self._ctrl, self._shift, self._alt, self._meta = bool(dom.ctrlKey), bool(dom.shiftKey), bool(dom.altKey), bool(dom.metaKey)
                if kind == "wheel":
                    self._wheel = -int(dom.deltaY)
            except Exception:
                pass

    GetPosition = lambda self: _wx.Point(self._x, self._y)
    GetLogicalPosition = lambda self, *_: _wx.Point(self._x, self._y)
    GetX = lambda self: self._x
    GetY = lambda self: self._y
    x = property(lambda self: self._x)
    y = property(lambda self: self._y)
    X = property(lambda self: self._x)
    Y = property(lambda self: self._y)
    GetPositionTuple = lambda self: (self._x, self._y)
    LeftDown = lambda self: self._kind == "mousedown" and self._button == 0
    LeftUp = lambda self: self._kind == "mouseup" and self._button == 0
    LeftDClick = lambda self: self._kind == "dblclick"
    RightDown = lambda self: self._kind == "mousedown" and self._button == 2
    RightUp = lambda self: self._kind == "mouseup" and self._button == 2
    MiddleDown = lambda self: self._kind == "mousedown" and self._button == 1
    MiddleUp = lambda self: self._kind == "mouseup" and self._button == 1
    LeftIsDown = lambda self: bool(self._buttons & 1) or (self._kind == "mousedown" and self._button == 0)
    RightIsDown = lambda self: bool(self._buttons & 2)
    MiddleIsDown = lambda self: bool(self._buttons & 4)
    ButtonDown = lambda self, *_: self._kind == "mousedown"
    ButtonUp = lambda self, *_: self._kind == "mouseup"
    ButtonDClick = lambda self, *_: self._kind == "dblclick"
    Dragging = lambda self: self._kind == "mousemove" and self._buttons != 0
    Moving = lambda self: self._kind == "mousemove" and self._buttons == 0
    Entering = lambda self: self._kind == "mouseenter"
    Leaving = lambda self: self._kind == "mouseleave"
    GetButton = lambda self: {0: 1, 1: 2, 2: 3}.get(self._button, 0)
    GetWheelRotation = lambda self: self._wheel
    GetWheelDelta = lambda self: 120
    GetWheelAxis = lambda self: 0
    GetLinesPerAction = lambda self: 3
    ControlDown = CmdDown = lambda self: self._ctrl
    ShiftDown = lambda self: self._shift
    AltDown = lambda self: self._alt
    MetaDown = lambda self: self._meta
    HasModifiers = HasAnyModifiers = lambda self: self._ctrl or self._alt or self._meta
    GetModifiers = lambda self: (2 if self._ctrl else 0) | (4 if self._shift else 0) | (1 if self._alt else 0)


_KEYS = {"Enter": 13, "Escape": 27, "Tab": 9, "Backspace": 8, "Delete": 127, " ": 32, "ArrowLeft": 314, "ArrowUp": 315, "ArrowRight": 316,
         "ArrowDown": 317, "End": 312, "Home": 313, "Insert": 322, "PageUp": 366, "PageDown": 367, "Shift": 306, "Alt": 307, "Control": 308,
         "Meta": 396, "CapsLock": 311, "Pause": 310}
_KEYS.update({"F%d" % i: 339 + i for i in range(1, 25)})


class KeyEvent(_wx.Event):
    """A key pressed or released in a window, with wxWidgets' key codes."""

    def __init__(self, source=None, binder=None, dom=None, char=False):
        _wx.Event.__init__(self, source, binder)
        self._ctrl = self._shift = self._alt = self._meta = self._repeat = False
        self._uni = 0
        key = ""
        if isinstance(dom, (str, int)):
            key = chr(dom) if isinstance(dom, int) and dom < 256 and dom not in _KEYS.values() else dom
            if isinstance(key, int):
                self._wx_key = key
                key = ""
        elif dom is not None:
            try:
                key = str(dom.key or "")
                self._ctrl, self._shift, self._alt, self._meta = bool(dom.ctrlKey), bool(dom.shiftKey), bool(dom.altKey), bool(dom.metaKey)
                self._repeat = bool(dom.repeat)
                if str(getattr(dom, "code", "")) == "NumpadEnter":
                    key = "NumpadEnter"
            except Exception:
                key = ""
        if key == "NumpadEnter":
            self._wx_key = 370
        elif key in _KEYS:
            self._wx_key = _KEYS[key]
        elif len(key) == 1:
            self._uni = ord(key)
            # a key going down is named by its capital letter; the character typed keeps its case
            self._wx_key = ord(key) if char else ord(key.upper())
        if self._wx_key in (13, 27, 9, 8, 127, 32):
            self._uni = self._wx_key

    GetKeyCode = lambda self: self._wx_key
    GetUnicodeKey = lambda self: self._uni

    # a key event a plugin makes itself, to send to a window
    def SetKeyCode(self, code):
        self._wx_key = int(code)

    def SetUnicodeKey(self, code):
        self._uni = int(code or 0)

    def SetControlDown(self, on=True):
        self._ctrl = bool(on)

    def SetShiftDown(self, on=True):
        self._shift = bool(on)

    def SetAltDown(self, on=True):
        self._alt = bool(on)

    def SetMetaDown(self, on=True):
        self._meta = bool(on)

    SetRawControlDown = SetControlDown
    GetRawKeyCode = lambda self: self._wx_key
    GetRawKeyFlags = lambda self: 0
    KeyCode = property(lambda self: self._wx_key)
    ControlDown = RawControlDown = lambda self: self._ctrl
    CmdDown = lambda self: self._ctrl or self._meta
    ShiftDown = lambda self: self._shift
    AltDown = lambda self: self._alt
    MetaDown = lambda self: self._meta
    HasModifiers = HasAnyModifiers = lambda self: self._ctrl or self._alt or self._meta
    GetModifiers = lambda self: (2 if self._ctrl else 0) | (4 if self._shift else 0) | (1 if self._alt else 0) | (8 if self._meta else 0)
    IsAutoRepeat = lambda self: self._repeat
    IsKeyInCategory = lambda self, *_: False
    GetPosition = lambda self: _wx.Point(0, 0)
    DoAllowNextEvent = lambda self: None


class FocusEvent(_wx.Event):
    def __init__(self, source=None, binder=None, other=None):
        _wx.Event.__init__(self, source, binder)
        self._other = other

    GetWindow = lambda self: self._other


def _focusable(win):
    """A window that takes keys or the focus can be focused: a plain element needs a tab index for that."""
    d = win.__dict__
    if d.get("_wx_focusable"):
        return
    d["_wx_focusable"] = True
    if str(getattr(win.el, "tagName", "DIV")).upper() in ("DIV", "SPAN", "SECTION", "FIELDSET", "LABEL", "CANVAS"):
        try:
            win.el.tabIndex = 0
            win.el.style.outline = "none"
        except Exception:
            pass

    def focused(e=None):
        d["_wx_focused"] = True
        _wx._focus[0] = win
        win._wx_fire(_wx.EVT_SET_FOCUS, FocusEvent(win, _wx.EVT_SET_FOCUS))

    def blurred(e=None):
        d["_wx_focused"] = False
        if _wx._focus[0] is win:
            _wx._focus[0] = None
        win._wx_fire(_wx.EVT_KILL_FOCUS, FocusEvent(win, _wx.EVT_KILL_FOCUS))
    _wx._listen(win.el, "focus", focused)
    _wx._listen(win.el, "blur", blurred)


def key_down(win, dom, target_is_self=True):
    """A key went down in a window: wxWidgets asks the hook first, then the key handlers, then the character
    handlers; what none of them takes goes to the window's own behaviour.  True when something took the key."""
    w = _wx
    if win._wx_fire(w.EVT_CHAR_HOOK, KeyEvent(win, w.EVT_CHAR_HOOK, dom)):
        return True
    if not target_is_self:
        return False
    if win._wx_fire(w.EVT_KEY_DOWN, KeyEvent(win, w.EVT_KEY_DOWN, dom)):
        return True
    if win._wx_fire(w.EVT_CHAR, KeyEvent(win, w.EVT_CHAR, dom, True)):
        return True
    own = getattr(win, "_wx_default_key", None)
    return bool(own(KeyEvent(win, w.EVT_KEY_DOWN, dom))) if own is not None else False


def _listen_keys(win):
    w = _wx
    _focusable(win)

    def down(e=None):
        mine = True
        if e is not None and w._DOM:
            try:
                mine = bool(win.el.isSameNode(e.target))
            except Exception:
                mine = True
        if key_down(win, e if w._DOM else None, mine) and e is not None and w._DOM:
            e.preventDefault()
            e.stopPropagation()

    def up(e=None):
        win._wx_fire(w.EVT_KEY_UP, KeyEvent(win, w.EVT_KEY_UP, e if w._DOM else None))
    w._listen(win.el, "keydown", down)
    w._listen(win.el, "keyup", up)


def fire_mouse(win, kind, x=None, y=None, button=0, wheel=0):
    """Deliver a mouse event to a window as the browser would (kind: mousedown, mouseup, dblclick, mousemove,
    mouseenter, mouseleave, wheel) at a point inside it; the tests use this to work a control that paints itself."""
    w = _wx
    if x is None or y is None:
        bw, bh = win._wx_box()
        x, y = bw // 2, bh // 2
    handled = False
    for binder, b in _mouse_table()[kind]:
        if b is not None and b != button:
            continue
        ev = MouseEvent(win, binder, None, kind)
        ev._x, ev._y, ev._button, ev._wheel = int(x), int(y), button, wheel
        ev._buttons = (1 << button) if kind in ("mousedown", "mousemove") and button in (0, 1, 2) and kind == "mousedown" else 0
        handled = win._wx_fire(binder, ev)
        if not handled:
            again = MouseEvent(win, w.EVT_MOUSE_EVENTS, None, kind)
            again._x, again._y, again._button, again._wheel, again._buttons = ev._x, ev._y, ev._button, ev._wheel, ev._buttons
            handled = win._wx_fire(w.EVT_MOUSE_EVENTS, again)
        if not handled:
            own = getattr(win, "_wx_default_mouse", None)
            if own is not None:
                own(ev)
    return handled


def wire(win, binder):
    """A plugin bound a paint, size, mouse, key or focus event of a window: the browser's own events are passed on from now."""
    if not isinstance(win, _wx.Window):
        return
    d = win.__dict__
    wired = d.setdefault("_wx_wired", set())
    w = _wx
    if binder in (w.EVT_KEY_DOWN, w.EVT_KEY_UP, w.EVT_CHAR, w.EVT_CHAR_HOOK):
        if "keys" not in wired:
            wired.add("keys")
            _listen_keys(win)
        return
    if binder in (w.EVT_SET_FOCUS, w.EVT_KILL_FOCUS):
        _focusable(win)
        return
    if binder in (w.EVT_SCROLLWIN, w.EVT_SCROLLWIN_THUMBTRACK, w.EVT_SCROLLWIN_THUMBRELEASE):
        if "scroll" not in wired:
            wired.add("scroll")

            def scrolled(e=None):
                for b in (w.EVT_SCROLLWIN, w.EVT_SCROLLWIN_THUMBTRACK, w.EVT_SCROLLWIN_THUMBRELEASE):
                    ev = w.Event(win, b)
                    ev.GetOrientation = lambda: w.VERTICAL
                    ev.GetPosition = lambda: win.GetScrollPos(w.VERTICAL)
                    win._wx_fire(b, ev)
            w._listen(win._wx_scroller() if hasattr(win, "_wx_scroller") else win.el, "scroll", scrolled)
        return
    if binder in (w.EVT_PAINT, w.EVT_SIZE):
        if "size" not in wired:
            wired.add("size")
            if binder is w.EVT_PAINT:
                _canvas(win)
            if w._DOM:
                from pyodide.ffi import create_proxy

                def resized(*_):
                    box = win._wx_box()
                    if d.get("_wx_last_box") != box:
                        d["_wx_last_box"] = box
                        win._wx_fire(w.EVT_SIZE, w.Event(win, w.EVT_SIZE))
                    schedule_paint(win)
                try:
                    w._kc().observe(win.el, w._kc().promising(create_proxy(resized)))
                except Exception:
                    pass
        if binder is w.EVT_PAINT:
            _canvas(win)
            if w._DOM:
                schedule_paint(win)
        return
    for dom, entries in _mouse_table().items():
        for b, button in entries:
            if b is binder and dom not in wired:
                wired.add(dom)
                _listen_mouse(win, dom)
    if binder is w.EVT_MOUSE_EVENTS:
        for dom in _mouse_table():
            if dom not in wired:
                wired.add(dom)
                _listen_mouse(win, dom)


def _listen_mouse(win, dom):
    w = _wx

    def on(e=None):
        for binder, button in _mouse_table()[dom]:
            if button is not None and e is not None and w._DOM and int(e.button) != button:
                continue
            ev = MouseEvent(win, binder, e if w._DOM else None, dom)
            handled = win._wx_fire(binder, ev)
            if not handled:
                handled = win._wx_fire(w.EVT_MOUSE_EVENTS, MouseEvent(win, w.EVT_MOUSE_EVENTS, e if w._DOM else None, dom))
            if not handled:
                own = getattr(win, "_wx_default_mouse", None)          # what the control does by itself with a click nobody took
                if own is not None:
                    own(ev)
            if dom == "contextmenu" and handled and e is not None and w._DOM:
                e.preventDefault()
    w._listen(win.el, dom, on)
