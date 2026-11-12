"""QPainter, QPainterPath and the pixel side of QPixmap/QImage, on the drawing steps of wx/_paint.py: what a Qt plugin
paints in paintEvent (or on a pixmap) is drawn on a <canvas> in its window."""
import math as _math

import wx
from wx import _paint

from .QtCore import Qt, QPoint, QPointF, QRect, QRectF, QSize, QLine


def _xy(p):
    return (p.x(), p.y()) if hasattr(p, "x") and callable(p.x) else (p[0], p[1])


def _rect(a):
    """(x, y, w, h) and the arguments left over, from QRect/QRectF or four numbers."""
    if a and hasattr(a[0], "width") and callable(a[0].width) and hasattr(a[0], "x"):
        r = a[0]
        return (r.x(), r.y(), r.width(), r.height()), a[1:]
    return (a[0], a[1], a[2], a[3]), a[4:]


def _flagval(v):
    try:
        return int(getattr(v, "value", v))
    except (TypeError, ValueError):
        return 0


def _wx_colour(c):
    from .QtGui import QColor
    if not isinstance(c, QColor):
        c = QColor(c)
    r, g, b, a = c._c
    return wx.Colour(r, g, b, a)


_DASH = {"DashLine": wx.PENSTYLE_SHORT_DASH, "DotLine": wx.PENSTYLE_DOT, "DashDotLine": wx.PENSTYLE_DOT_DASH,
         "DashDotDotLine": wx.PENSTYLE_DOT_DASH, "CustomDashLine": wx.PENSTYLE_SHORT_DASH}


def _wx_pen(pen):
    style = getattr(pen, "_style", None)
    name = getattr(style, "name", "SolidLine")
    if name == "NoPen":
        return wx.TRANSPARENT_PEN
    width = getattr(pen, "_width", 1) or 1          # Qt's width 0 is a "cosmetic" one pixel line
    p = wx.Pen(_wx_colour(pen.color()), width, _DASH.get(name, wx.PENSTYLE_SOLID))
    cap = getattr(getattr(pen, "_cap", None), "name", "")
    if cap == "RoundCap":
        p.SetCap(wx.CAP_ROUND)
    elif cap == "SquareCap":
        p.SetCap(wx.CAP_PROJECTING)
    elif cap == "FlatCap":
        p.SetCap(wx.CAP_BUTT)
    return p


def _wx_font(font):
    size = font._size if getattr(font, "_size", 0) and font._size > 0 else 9
    f = wx.Font(int(size), wx.FONTFAMILY_DEFAULT, wx.FONTSTYLE_ITALIC if getattr(font, "_italic", False) else wx.FONTSTYLE_NORMAL,
                wx.FONTWEIGHT_BOLD if getattr(font, "_bold", False) or getattr(font, "_weight", 400) >= 600 else wx.FONTWEIGHT_NORMAL)
    px = getattr(font, "_px", 0)
    if px and px > 0:
        f.SetPointSize(max(1, int(round(px * 0.75))))
    fam = getattr(font, "_family", "")
    if fam:
        f.SetFaceName(str(fam))
    return f


class QPainterPath:
    class ElementType:
        MoveToElement, LineToElement, CurveToElement, CurveToDataElement = range(4)

    def __init__(self, start=None):
        self._p = _paint.GraphicsPath()
        self._fill = None
        if start is not None:
            self.moveTo(start)

    def _n(self, a):
        out = []
        for v in a:
            if hasattr(v, "x") and callable(v.x):
                out.extend((v.x(), v.y()))
            else:
                out.append(v)
        return out

    def moveTo(self, *a):
        self._p.MoveToPoint(*self._n(a))

    def lineTo(self, *a):
        self._p.AddLineToPoint(*self._n(a))

    def cubicTo(self, *a):
        self._p.AddCurveToPoint(*self._n(a))

    def quadTo(self, *a):
        self._p.AddQuadCurveToPoint(*self._n(a))

    def closeSubpath(self):
        self._p.CloseSubpath()

    def addRect(self, *a):
        (x, y, w, h), _ = _rect(a)
        self._p.AddRectangle(x, y, w, h)

    def addEllipse(self, *a):
        if len(a) == 3:                     # centre, rx, ry
            cx, cy = _xy(a[0])
            self._p.AddEllipse(cx - a[1], cy - a[2], 2 * a[1], 2 * a[2])
            return
        (x, y, w, h), _ = _rect(a)
        self._p.AddEllipse(x, y, w, h)

    def addRoundedRect(self, *a):
        (x, y, w, h), rest = _rect(a)
        self._p.AddRoundedRectangle(x, y, w, h, rest[0] if rest else 0)

    def addPolygon(self, poly):
        pts = [_xy(p) for p in poly]
        if pts:
            self._p.MoveToPoint(*pts[0])
            for p in pts[1:]:
                self._p.AddLineToPoint(*p)

    def addPath(self, other):
        self._p.AddPath(other._p)

    connectPath = addPath

    def arcTo(self, *a):
        (x, y, w, h), rest = _rect(a)
        start, sweep = rest[0], rest[1]
        # Qt: degrees, counter-clockwise from 3 o'clock; the canvas: radians, clockwise
        r = w / 2.0
        a0, a1 = -_math.radians(start), -_math.radians(start + sweep)
        if abs(w - h) < 1e-9:
            self._p.AddLineToPoint(x + r + r * _math.cos(a0), y + r + r * _math.sin(a0))
            self._p.AddArc(x + r, y + r, r, a0, a1, sweep < 0)
        else:
            n = max(4, int(abs(sweep) / 10))
            for i in range(n + 1):
                t = a0 + (a1 - a0) * i / n
                self._p.AddLineToPoint(x + w / 2.0 + w / 2.0 * _math.cos(t), y + h / 2.0 + h / 2.0 * _math.sin(t))

    def arcMoveTo(self, *a):
        (x, y, w, h), rest = _rect(a)
        t = -_math.radians(rest[0])
        self._p.MoveToPoint(x + w / 2.0 + w / 2.0 * _math.cos(t), y + h / 2.0 + h / 2.0 * _math.sin(t))

    def addText(self, *a):
        pass

    def setFillRule(self, rule):
        self._fill = rule

    def isEmpty(self):
        return not self._p._c

    def boundingRect(self):
        x, y, w, h = self._p.GetBox()
        return QRectF(x, y, w, h)

    controlPointRect = boundingRect

    def currentPosition(self):
        p = self._p.GetCurrentPoint()
        return QPointF(p[0], p[1])

    def contains(self, p):
        return self._p.Contains(*_xy(p))

    intersects = lambda self, *a: False
    elementCount = lambda self: len([c for c in self._p._c if isinstance(c, str)])

    def translated(self, *a):
        dx, dy = _xy(a[0]) if len(a) == 1 else a[:2]
        out = QPainterPath()
        step = {"M": 2, "L": 2, "C": 6, "Q": 4, "T": 4, "E": 2, "R": 2, "O": 2, "A": 2}
        c, i = self._p._c, 0
        while i < len(c):
            op = c[i]
            out._p._c.append(op)
            i += 1
            k = 0
            while i < len(c) and not isinstance(c[i], str):
                moves = k < step.get(op, 0)
                out._p._c.append(c[i] + (dx if k % 2 == 0 else dy) if moves else c[i])
                i += 1
                k += 1
        b = self._p._box
        out._p._box = (b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy) if b else None
        return out

    simplified = lambda self: self
    toFillPolygon = lambda self, *a: []


class QPainter:
    """Qt's painter: on a widget it draws on that widget's canvas, on a pixmap or image into its pixels."""

    class RenderHint:
        Antialiasing, TextAntialiasing, SmoothPixmapTransform, LosslessImageRendering = 1, 2, 4, 0x40

    class CompositionMode:
        CompositionMode_SourceOver, CompositionMode_Clear, CompositionMode_Source = 0, 2, 3

    Antialiasing, TextAntialiasing, SmoothPixmapTransform = 1, 2, 4
    CompositionMode_SourceOver, CompositionMode_Clear, CompositionMode_Source = 0, 2, 3

    def __init__(self, device=None):
        from .QtGui import QPen, QBrush, QFont
        self._device = None
        self._gc = None
        self._dc = None
        self._pen, self._brush, self._font = QPen(), QBrush(Qt.BrushStyle.NoBrush), QFont()
        self._stack = []
        self._opacity = 1.0
        self._layers = 0
        self._bg = None
        if device is not None:
            self.begin(device)

    # -- where it paints
    def begin(self, device):
        from .QtGui import QBrush
        self._device = device
        w = getattr(device, "_w", None)
        bmp = getattr(device, "_bmp", None)
        if isinstance(w, wx.Window):
            self._dc = wx.PaintDC(w) if w.__dict__.get("_wx_painting") else wx.ClientDC(w)
            self._font = device.font() if hasattr(device, "font") else self._font
        elif bmp is not None or hasattr(device, "_pixels"):
            bmp = device._pixels()
            self._dc = wx.MemoryDC(bmp)
        else:
            self._dc = wx.MemoryDC(wx.Bitmap(1, 1))
        self._gc = wx.GraphicsContext.Create(self._dc)
        self._brush = QBrush(Qt.BrushStyle.NoBrush)
        self._apply()
        return True

    def end(self):
        if self._gc is None:
            return True
        while self._layers:
            self._gc.EndLayer()
            self._layers -= 1
        dc, self._dc, self._gc = self._dc, None, None
        if dc is not None:
            if isinstance(dc, wx.MemoryDC):
                dc.SelectObject(wx.NullBitmap)
            dc._flush()
        return True

    def isActive(self):
        return self._gc is not None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.end()
        return False

    def __del__(self):
        try:
            self.end()
        except Exception:
            pass

    def device(self):
        return self._device

    def window(self):
        d = self._device
        return QRect(0, 0, d.width(), d.height()) if d is not None and hasattr(d, "width") else QRect(0, 0, 0, 0)

    viewport = window

    # -- tools
    def _apply(self):
        if self._gc is None:
            return
        self._gc.SetPen(_wx_pen(self._pen))
        self._gc.SetBrush(self._wx_brush(self._brush))
        self._gc.SetFont(_wx_font(self._font), _wx_colour(self._pen.color()))

    def _wx_brush(self, brush):
        grad = getattr(brush, "_gradient", None)
        if grad is not None and self._gc is not None:
            stops = sorted(grad.stops(), key=lambda s: s[0])
            if stops:
                c1, c2 = _wx_colour(stops[0][1]), _wx_colour(stops[-1][1])
                g = getattr(grad, "_geom", None)
                if g and len(g) == 4:
                    return self._gc.CreateLinearGradientBrush(g[0], g[1], g[2], g[3], c1, c2)
                if g and len(g) >= 3:
                    return self._gc.CreateRadialGradientBrush(g[0], g[1], g[0], g[1], g[2], c1, c2)
        if getattr(getattr(brush, "_style", None), "name", "SolidPattern") == "NoBrush":
            return wx.TRANSPARENT_BRUSH
        return wx.Brush(_wx_colour(brush.color()))

    def pen(self):
        return self._pen

    def setPen(self, p):
        from .QtGui import QPen
        if isinstance(p, QPen):
            self._pen = p
        elif getattr(p, "name", "") == "NoPen":
            self._pen = QPen(Qt.PenStyle.NoPen)
        else:
            self._pen = QPen(p)
        self._apply()

    def brush(self):
        return self._brush

    def setBrush(self, b):
        from .QtGui import QBrush
        self._brush = b if isinstance(b, QBrush) else QBrush(b)
        self._apply()

    def font(self):
        return self._font

    def setFont(self, f):
        self._font = f
        self._apply()

    def fontMetrics(self):
        from .QtGui import QFontMetrics
        return QFontMetrics(self._font)

    fontInfo = fontMetrics

    def background(self):
        from .QtGui import QBrush
        return self._bg or QBrush(Qt.GlobalColor.white)

    def setBackground(self, b):
        self._bg = b

    setRenderHint = setRenderHints = setCompositionMode = setBackgroundMode = setBrushOrigin = setLayoutDirection = \
        setWorldMatrixEnabled = setViewTransformEnabled = lambda self, *a, **k: None
    testRenderHint = lambda self, *a: True
    renderHints = lambda self: 1
    compositionMode = lambda self: 0

    # -- state and transforms
    def save(self):
        self._stack.append((self._pen, self._brush, self._font, self._opacity, self._layers))
        self._gc.PushState()

    def restore(self):
        if not self._stack:
            return
        self._pen, self._brush, self._font, self._opacity, layers = self._stack.pop()
        while self._layers > layers:
            self._gc.EndLayer()
            self._layers -= 1
        self._gc.PopState()
        self._gc._state.clear()
        self._apply()

    def translate(self, *a):
        dx, dy = _xy(a[0]) if len(a) == 1 else a[:2]
        self._gc.Translate(dx, dy)

    def scale(self, sx, sy):
        self._gc.Scale(sx, sy)

    def rotate(self, degrees):
        self._gc.Rotate(_math.radians(degrees))

    def shear(self, *a):
        pass

    def resetTransform(self):
        pass

    def setTransform(self, t, combine=False):
        m = getattr(t, "_m", None)
        if m:
            self._gc.Translate(m[4], m[5])
            self._gc.Scale(m[0] or 1, m[3] or 1)

    setWorldTransform = setWorldMatrix = setMatrix = setTransform

    def transform(self):
        from .QtGui import QTransform
        return QTransform()

    worldTransform = deviceTransform = combinedTransform = transform

    def setClipRect(self, *a):
        (x, y, w, h), _ = _rect(a)
        self._gc.Clip(x, y, w, h)

    def setClipPath(self, path, *a):
        x, y, w, h = path._p.GetBox()
        self._gc.Clip(x, y, w, h)

    def setClipping(self, on):
        if not on:
            self._gc.ResetClip()

    setClipRegion = lambda self, *a: None
    hasClipping = lambda self: False

    def opacity(self):
        return self._opacity

    def setOpacity(self, value):
        value = max(0.0, min(1.0, float(value)))
        if self._layers and self._stack and self._stack[-1][4] < self._layers:
            self._gc.EndLayer()
            self._layers -= 1
        self._opacity = value
        if value < 1.0:
            self._gc.BeginLayer(value)
            self._layers += 1

    # -- shapes
    def drawLine(self, *a):
        if len(a) == 1:                     # QLine / QLineF
            l = a[0]
            x1, y1, x2, y2 = l.x1(), l.y1(), l.x2(), l.y2()
        elif len(a) == 2:
            (x1, y1), (x2, y2) = _xy(a[0]), _xy(a[1])
        else:
            x1, y1, x2, y2 = a[:4]
        self._gc.StrokeLine(x1, y1, x2, y2)

    def drawLines(self, *a):
        items = a[0] if len(a) == 1 else a
        items = list(items)
        if items and hasattr(items[0], "x1"):
            for l in items:
                self.drawLine(l)
        else:
            for p, q in zip(items[0::2], items[1::2]):
                self.drawLine(p, q)

    def drawPolyline(self, *a):
        pts = [_xy(p) for p in (a[0] if len(a) == 1 else a)]
        if len(pts) > 1:
            self._gc.StrokeLines(pts)

    def drawPolygon(self, *a):
        pts = a[0] if a and not (hasattr(a[0], "x") and callable(a[0].x)) else a
        pts = [_xy(p) for p in pts if hasattr(p, "x") or isinstance(p, (tuple, list))]
        if len(pts) > 2:
            self._gc.DrawLines(pts + [pts[0]])

    drawConvexPolygon = drawPolygon

    def drawPoint(self, *a):
        x, y = _xy(a[0]) if len(a) == 1 else a[:2]
        w = max(1.0, float(getattr(self._pen, "_width", 1) or 1))
        self._gc.SetBrush(wx.Brush(_wx_colour(self._pen.color())))
        self._gc.SetPen(wx.TRANSPARENT_PEN)
        self._gc.DrawEllipse(x - w / 2, y - w / 2, w, w)
        self._apply()

    def drawPoints(self, *a):
        for p in (a[0] if len(a) == 1 else a):
            self.drawPoint(p)

    def drawRect(self, *a):
        (x, y, w, h), _ = _rect(a)
        self._gc.DrawRectangle(x, y, w, h)

    def drawRects(self, *a):
        for r in (a[0] if len(a) == 1 and not hasattr(a[0], "width") else a):
            self.drawRect(r)

    def drawRoundedRect(self, *a):
        (x, y, w, h), rest = _rect(a)
        self._gc.DrawRoundedRectangle(x, y, w, h, rest[0] if rest else 0)

    drawRoundRect = drawRoundedRect

    def drawEllipse(self, *a):
        if len(a) == 3:                     # centre, rx, ry
            cx, cy = _xy(a[0])
            self._gc.DrawEllipse(cx - a[1], cy - a[2], 2 * a[1], 2 * a[2])
            return
        (x, y, w, h), _ = _rect(a)
        self._gc.DrawEllipse(x, y, w, h)

    def _arc_path(self, a, pie=False, chord=False):
        (x, y, w, h), rest = _rect(a)
        start, span = rest[0] / 16.0, rest[1] / 16.0          # Qt: sixteenths of a degree
        p = QPainterPath()
        if pie:
            p.moveTo(x + w / 2.0, y + h / 2.0)
            p.arcTo(x, y, w, h, start, span)
            p.closeSubpath()
        else:
            p.arcMoveTo(x, y, w, h, start)
            p.arcTo(x, y, w, h, start, span)
            if chord:
                p.closeSubpath()
        return p

    def drawArc(self, *a):
        self._gc.StrokePath(self._arc_path(a)._p)

    def drawPie(self, *a):
        self._gc.DrawPath(self._arc_path(a, pie=True)._p)

    def drawChord(self, *a):
        self._gc.DrawPath(self._arc_path(a, chord=True)._p)

    def drawPath(self, path):
        self._gc.DrawPath(path._p)

    def strokePath(self, path, pen):
        self._gc.SetPen(_wx_pen(pen))
        self._gc.StrokePath(path._p)
        self._apply()

    def fillPath(self, path, brush):
        from .QtGui import QBrush
        self._gc.SetBrush(self._wx_brush(brush if isinstance(brush, QBrush) else QBrush(brush)))
        self._gc.FillPath(path._p)
        self._apply()

    def fillRect(self, *a):
        from .QtGui import QBrush, QColor
        (x, y, w, h), rest = _rect(a)
        fill = rest[0] if rest else self._brush
        if not isinstance(fill, QBrush):
            fill = QBrush(fill if isinstance(fill, QColor) else QColor(fill))
        self._gc.SetPen(wx.TRANSPARENT_PEN)
        self._gc.SetBrush(self._wx_brush(fill))
        self._gc.DrawRectangle(x, y, w, h)
        self._apply()

    def eraseRect(self, *a):
        (x, y, w, h), _ = _rect(a)
        self.fillRect(x, y, w, h, self.background())

    # -- text
    def _measure(self, text):
        w, h = _paint.text_extent(text, _wx_font(self._font))
        return w, h

    def drawText(self, *a):
        if not a:
            return
        text = a[-1] if isinstance(a[-1], str) else next((v for v in a if isinstance(v, str)), "")
        if hasattr(a[0], "width") and callable(a[0].width) and hasattr(a[0], "x"):          # (rect, flags, text)
            r = a[0]
            flags = _flagval(a[1]) if len(a) > 2 else 0
            self._text_in(r.x(), r.y(), r.width(), r.height(), flags, text)
        elif len(a) >= 6 and all(isinstance(v, (int, float)) for v in a[:4]):               # (x, y, w, h, flags, text)
            self._text_in(a[0], a[1], a[2], a[3], _flagval(a[4]), text)
        else:                                                                               # (point, text) / (x, y, text): the baseline
            x, y = _xy(a[0]) if len(a) == 2 else a[:2]
            w, h = self._measure(text)
            self._gc.DrawText(text, x, y - h * 0.8)

    def _text_in(self, x, y, w, h, flags, text):
        lines = str(text).split("\n")
        if flags & 0x1000:                       # TextWordWrap
            wrapped = []
            for line in lines:
                cur = ""
                for word in line.split(" "):
                    trial = word if not cur else cur + " " + word
                    if self._measure(trial)[0] <= w or not cur:
                        cur = trial
                    else:
                        wrapped.append(cur)
                        cur = word
                wrapped.append(cur)
            lines = wrapped
        lh = self._measure("Ag")[1]
        total = lh * len(lines)
        top = y + (h - total) / 2.0 if flags & 0x80 else (y + h - total if flags & 0x40 else y)
        for i, line in enumerate(lines):
            lw = self._measure(line)[0]
            left = x + (w - lw) / 2.0 if flags & 0x4 else (x + w - lw if flags & 0x2 else x)
            self._gc.DrawText(line, left, top + i * lh)

    def boundingRect(self, *a):
        text = next((v for v in a if isinstance(v, str)), "")
        lines = str(text).split("\n")
        w = max((self._measure(l)[0] for l in lines), default=0)
        h = self._measure("Ag")[1] * len(lines)
        if a and hasattr(a[0], "x") and hasattr(a[0], "width"):
            return QRect(int(a[0].x()), int(a[0].y()), int(_math.ceil(w)), int(_math.ceil(h)))
        return QRect(0, 0, int(_math.ceil(w)), int(_math.ceil(h)))

    drawStaticText = lambda self, *a: None

    # -- pictures
    def _picture(self, a):
        """(x, y, w, h, bitmap) for drawPixmap / drawImage in their usual forms."""
        pm = next((v for v in a if hasattr(v, "_pixels")), None)
        if pm is None:
            return None
        bmp = pm._pixels()
        nums = []
        for v in a:
            if v is pm:
                break
            if hasattr(v, "width") and callable(v.width) and hasattr(v, "x"):
                nums = [v.x(), v.y(), v.width(), v.height()]
            elif hasattr(v, "x") and callable(v.x):
                nums = [v.x(), v.y()]
            elif isinstance(v, (int, float)):
                nums.append(v)
        x, y = (nums + [0, 0])[:2]
        w = nums[2] if len(nums) > 3 else (pm.width() or bmp.GetWidth())
        h = nums[3] if len(nums) > 3 else (pm.height() or bmp.GetHeight())
        return x, y, w, h, bmp

    def drawPixmap(self, *a):
        got = self._picture(a)
        if got and got[4].IsOk():
            x, y, w, h, bmp = got
            self._gc.DrawBitmap(bmp, x, y, w, h)

    drawImage = drawPixmap
    drawTiledPixmap = drawPicture = lambda self, *a: None

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None
