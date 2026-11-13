"""pyclipper for KiCad plugins in the web editor: polygon clipping and offsetting with pyclipper's interface,
worked out by shapely (GEOS), which the web editor has, in place of the compiled Clipper library, which it has not.
Paths are lists of integer [x, y] points, as with the real module."""
from shapely import geometry as _g
from shapely.ops import unary_union as _union

CT_INTERSECTION, CT_UNION, CT_DIFFERENCE, CT_XOR = 0, 1, 2, 3
PT_SUBJECT, PT_CLIP = 0, 1
PFT_EVENODD, PFT_NONZERO, PFT_POSITIVE, PFT_NEGATIVE = 0, 1, 2, 3
JT_SQUARE, JT_ROUND, JT_MITER = 0, 1, 2
ET_CLOSEDPOLYGON, ET_CLOSEDLINE, ET_OPENBUTT, ET_OPENSQUARE, ET_OPENROUND = 0, 1, 2, 3, 4
SILENT = True


class ClipperException(Exception):
    pass


def _ring(coords):
    pts = [[int(round(x)), int(round(y))] for x, y in coords]
    return pts[:-1] if len(pts) > 1 and pts[0] == pts[-1] else pts


def _paths(shape):
    """Outer rings counter-clockwise and holes clockwise, as Clipper hands them back."""
    out = []
    if shape is None or shape.is_empty:
        return out
    for part in getattr(shape, "geoms", [shape]):
        if part.geom_type == "Polygon":
            part = _g.polygon.orient(part, 1.0)
            out.append(_ring(part.exterior.coords))
            out.extend(_ring(hole.coords) for hole in part.interiors)
        elif hasattr(part, "geoms"):
            out.extend(_paths(part))
    return [p for p in out if len(p) >= 3]


def _area(path):
    return sum(path[i][0] * path[(i + 1) % len(path)][1] - path[(i + 1) % len(path)][0] * path[i][1] for i in range(len(path))) / 2.0


def _filled(paths, fill):
    """The region a set of closed paths covers under a fill rule."""
    polys = []
    for path in paths:
        if len(path) < 3:
            continue
        p = _g.Polygon(path)
        polys.append(p if p.is_valid else p.buffer(0))
    if not polys:
        return _g.Polygon()
    if fill == PFT_EVENODD:
        shape = polys[0]
        for p in polys[1:]:
            shape = shape.symmetric_difference(p)
        return shape
    if fill in (PFT_POSITIVE, PFT_NEGATIVE):
        keep = [p for p, path in zip(polys, [q for q in paths if len(q) >= 3]) if (_area(path) > 0) == (fill == PFT_POSITIVE)]
        return _union(keep) if keep else _g.Polygon()
    return _union(polys)


class Pyclipper:
    def __init__(self):
        self.Clear()

    def Clear(self):
        self._subject, self._clip, self._open = [], [], []

    def AddPath(self, path, poly_type, closed=True):
        if len(path) < (3 if closed else 2):
            raise ClipperException("The path is invalid for clipping")
        if not closed:
            if poly_type != PT_SUBJECT:
                raise ClipperException("Only subject paths may be open")
            self._open.append(list(path))
        else:
            (self._subject if poly_type == PT_SUBJECT else self._clip).append(list(path))
        return True

    def AddPaths(self, paths, poly_type, closed=True):
        for path in paths:
            self.AddPath(path, poly_type, closed)
        return True

    def _run(self, clip_type, subj_fill, clip_fill):
        a, b = _filled(self._subject, subj_fill), _filled(self._clip, clip_fill)
        if clip_type == CT_INTERSECTION:
            return a.intersection(b)
        if clip_type == CT_UNION:
            return a.union(b)
        if clip_type == CT_DIFFERENCE:
            return a.difference(b)
        if clip_type == CT_XOR:
            return a.symmetric_difference(b)
        raise ClipperException("Unknown clip type %r" % (clip_type,))

    def Execute(self, clip_type, subj_fill_type=PFT_EVENODD, clip_fill_type=PFT_EVENODD):
        return _paths(self._run(clip_type, subj_fill_type, clip_fill_type))

    def GetBounds(self):
        pts = [p for path in self._subject + self._clip + self._open for p in path]
        box = type("PyIntRect", (), {})()
        box.left, box.right = min(p[0] for p in pts), max(p[0] for p in pts)
        box.top, box.bottom = min(p[1] for p in pts), max(p[1] for p in pts)
        return box


_JOIN = {JT_SQUARE: "bevel", JT_ROUND: "round", JT_MITER: "mitre"}
_CAP = {ET_OPENBUTT: "flat", ET_OPENSQUARE: "square", ET_OPENROUND: "round"}


class PyclipperOffset:
    def __init__(self, miter_limit=2.0, arc_tolerance=0.25):
        self.MiterLimit, self.ArcTolerance = miter_limit, arc_tolerance
        self.Clear()

    def Clear(self):
        self._paths = []

    def AddPath(self, path, join_type, end_type):
        self._paths.append((list(path), join_type, end_type))

    def AddPaths(self, paths, join_type, end_type):
        for path in paths:
            self.AddPath(path, join_type, end_type)

    def _quad(self, delta):
        # as many segments to a quarter circle as keep the curve within the arc tolerance, as Clipper does
        import math
        r = abs(delta)
        if r <= self.ArcTolerance:
            return 4
        return max(4, int(math.ceil(math.pi / (2 * math.acos(1 - self.ArcTolerance / r)))))

    def Execute(self, delta):
        shapes = []
        for path, join, end in self._paths:
            style = dict(quad_segs=self._quad(delta), join_style=_JOIN.get(join, "round"), mitre_limit=self.MiterLimit)
            if end == ET_CLOSEDPOLYGON:
                if len(path) < 3:
                    continue
                poly = _g.Polygon(path)
                shapes.append((poly if poly.is_valid else poly.buffer(0)).buffer(delta, **style))
            elif end == ET_CLOSEDLINE:
                shapes.append(_g.LinearRing(path).buffer(abs(delta), **style))
            elif len(path) == 1:
                shapes.append(_g.Point(path[0]).buffer(abs(delta), quad_segs=style["quad_segs"]))
            else:
                shapes.append(_g.LineString(path).buffer(abs(delta), cap_style=_CAP.get(end, "round"), **style))
        return _paths(_union(shapes)) if shapes else []


def PointInPolygon(point, path):
    """1 inside, -1 on the edge, 0 outside."""
    poly, p = _g.Polygon(path), _g.Point(point)
    if poly.boundary.distance(p) == 0:
        return -1
    return 1 if poly.contains(p) else 0


def Area(path):
    return _area(path)


def Orientation(path):
    return _area(path) >= 0


def ReversePath(path):
    return list(reversed(path))


def ReversePaths(paths):
    return [list(reversed(p)) for p in paths]


def SimplifyPolygon(path, fill_type=PFT_EVENODD):
    return _paths(_filled([path], fill_type))


def SimplifyPolygons(paths, fill_type=PFT_EVENODD):
    return _paths(_filled(paths, fill_type))


def CleanPolygon(path, distance=1.415):
    return _ring(_g.Polygon(path).simplify(distance).exterior.coords) if len(path) >= 3 else []


def CleanPolygons(paths, distance=1.415):
    return [CleanPolygon(p, distance) for p in paths]


def scale_to_clipper(value, scale=2 ** 31):
    if isinstance(value, (list, tuple)):
        return [scale_to_clipper(v, scale) for v in value]
    return int(round(value * scale))


def scale_from_clipper(value, scale=2 ** 31):
    if isinstance(value, (list, tuple)):
        return [scale_from_clipper(v, scale) for v in value]
    return value / float(scale)
