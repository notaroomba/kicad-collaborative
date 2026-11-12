"""OpenGL.GL: the fixed-function calls, kept as state here and drawn by the browser's WebGL (see OpenGL/__init__.py)."""

import math as _math

# ----------------------------------------------------------------------------- constants (their OpenGL values)

GL_FALSE, GL_TRUE = 0, 1
GL_POINTS, GL_LINES, GL_LINE_LOOP, GL_LINE_STRIP, GL_TRIANGLES, GL_TRIANGLE_STRIP, GL_TRIANGLE_FAN, GL_QUADS, GL_QUAD_STRIP, GL_POLYGON = range(10)
GL_DEPTH_BUFFER_BIT, GL_STENCIL_BUFFER_BIT, GL_COLOR_BUFFER_BIT = 0x100, 0x400, 0x4000
GL_NEVER, GL_LESS, GL_EQUAL, GL_LEQUAL, GL_GREATER, GL_NOTEQUAL, GL_GEQUAL, GL_ALWAYS = range(0x200, 0x208)
GL_ZERO, GL_ONE = 0, 1
GL_SRC_COLOR, GL_ONE_MINUS_SRC_COLOR, GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_DST_ALPHA, GL_ONE_MINUS_DST_ALPHA, GL_DST_COLOR, GL_ONE_MINUS_DST_COLOR, GL_SRC_ALPHA_SATURATE = range(0x300, 0x309)
GL_FRONT, GL_BACK, GL_FRONT_AND_BACK = 0x404, 0x405, 0x408
GL_CW, GL_CCW = 0x900, 0x901
GL_POINT_SMOOTH, GL_LINE_SMOOTH, GL_POLYGON_SMOOTH, GL_LINE_STIPPLE = 0xB10, 0xB20, 0xB41, 0xB24
GL_CULL_FACE, GL_LIGHTING, GL_COLOR_MATERIAL, GL_FOG, GL_DEPTH_TEST, GL_STENCIL_TEST, GL_NORMALIZE, GL_ALPHA_TEST, GL_DITHER, GL_BLEND = 0xB44, 0xB50, 0xB57, 0xB60, 0xB71, 0xB90, 0xBA1, 0xBC0, 0xBD0, 0xBE2
GL_SCISSOR_TEST, GL_TEXTURE_1D, GL_TEXTURE_2D, GL_POLYGON_OFFSET_FILL, GL_POLYGON_OFFSET_LINE, GL_MULTISAMPLE, GL_RESCALE_NORMAL = 0xC11, 0xDE0, 0xDE1, 0x8037, 0x2A02, 0x809D, 0x803A
GL_LIGHT_MODEL_LOCAL_VIEWER, GL_LIGHT_MODEL_TWO_SIDE, GL_LIGHT_MODEL_AMBIENT = 0xB51, 0xB52, 0xB53
GL_SHADE_MODEL, GL_FLAT, GL_SMOOTH = 0xB54, 0x1D00, 0x1D01
GL_PERSPECTIVE_CORRECTION_HINT, GL_POINT_SMOOTH_HINT, GL_LINE_SMOOTH_HINT, GL_POLYGON_SMOOTH_HINT, GL_FOG_HINT = 0xC50, 0xC51, 0xC52, 0xC53, 0xC54
GL_DONT_CARE, GL_FASTEST, GL_NICEST = 0x1100, 0x1101, 0x1102
GL_AMBIENT, GL_DIFFUSE, GL_SPECULAR, GL_POSITION, GL_SPOT_DIRECTION, GL_SPOT_EXPONENT, GL_SPOT_CUTOFF, GL_CONSTANT_ATTENUATION, GL_LINEAR_ATTENUATION, GL_QUADRATIC_ATTENUATION = range(0x1200, 0x120A)
GL_EMISSION, GL_SHININESS, GL_AMBIENT_AND_DIFFUSE, GL_COLOR_INDEXES = 0x1600, 0x1601, 0x1602, 0x1603
GL_MODELVIEW, GL_PROJECTION, GL_TEXTURE = 0x1700, 0x1701, 0x1702
GL_MODELVIEW_MATRIX, GL_PROJECTION_MATRIX, GL_VIEWPORT, GL_CURRENT_COLOR, GL_LINE_WIDTH, GL_MAX_TEXTURE_SIZE, GL_MAX_LIGHTS = 0xBA6, 0xBA7, 0xBA2, 0xB00, 0xB21, 0xD33, 0xD31
GL_POINT, GL_LINE, GL_FILL = 0x1B00, 0x1B01, 0x1B02
GL_BYTE, GL_UNSIGNED_BYTE, GL_SHORT, GL_UNSIGNED_SHORT, GL_INT, GL_UNSIGNED_INT, GL_FLOAT, GL_DOUBLE = 0x1400, 0x1401, 0x1402, 0x1403, 0x1404, 0x1405, 0x1406, 0x140A
GL_DEPTH_COMPONENT, GL_RED, GL_ALPHA, GL_RGB, GL_RGBA, GL_LUMINANCE, GL_LUMINANCE_ALPHA, GL_BGR, GL_BGRA, GL_RGB8, GL_RGBA8 = 0x1902, 0x1903, 0x1906, 0x1907, 0x1908, 0x1909, 0x190A, 0x80E0, 0x80E1, 0x8051, 0x8058
GL_NEAREST, GL_LINEAR, GL_NEAREST_MIPMAP_NEAREST, GL_LINEAR_MIPMAP_NEAREST, GL_NEAREST_MIPMAP_LINEAR, GL_LINEAR_MIPMAP_LINEAR = 0x2600, 0x2601, 0x2700, 0x2701, 0x2702, 0x2703
GL_TEXTURE_MAG_FILTER, GL_TEXTURE_MIN_FILTER, GL_TEXTURE_WRAP_S, GL_TEXTURE_WRAP_T, GL_CLAMP, GL_REPEAT, GL_CLAMP_TO_EDGE = 0x2800, 0x2801, 0x2802, 0x2803, 0x2900, 0x2901, 0x812F
GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE, GL_DECAL, GL_REPLACE = 0x2300, 0x2200, 0x2100, 0x2101, 0x1E01
GL_VERTEX_ARRAY, GL_NORMAL_ARRAY, GL_COLOR_ARRAY, GL_INDEX_ARRAY, GL_TEXTURE_COORD_ARRAY, GL_EDGE_FLAG_ARRAY = range(0x8074, 0x807A)
GL_UNPACK_ALIGNMENT, GL_PACK_ALIGNMENT = 0xCF5, 0xD05
GL_COMPILE, GL_COMPILE_AND_EXECUTE = 0x1300, 0x1301
GL_NO_ERROR, GL_INVALID_ENUM, GL_INVALID_VALUE, GL_INVALID_OPERATION, GL_STACK_OVERFLOW, GL_STACK_UNDERFLOW, GL_OUT_OF_MEMORY = 0, 0x500, 0x501, 0x502, 0x503, 0x504, 0x505
GL_VENDOR, GL_RENDERER, GL_VERSION, GL_EXTENSIONS, GL_SHADING_LANGUAGE_VERSION = 0x1F00, 0x1F01, 0x1F02, 0x1F03, 0x8B8C
GL_ALL_ATTRIB_BITS, GL_ENABLE_BIT, GL_LIGHTING_BIT, GL_CURRENT_BIT, GL_LINE_BIT, GL_POLYGON_BIT, GL_VIEWPORT_BIT, GL_TRANSFORM_BIT, GL_TEXTURE_BIT = 0xFFFFF, 0x2000, 0x40, 0x1, 0x4, 0x8, 0x800, 0x1000, 0x40000
for _i in range(8):
    globals()["GL_LIGHT%d" % _i] = 0x4000 + _i
del _i

_WEBGL_MODE = {GL_POINTS: 0, GL_LINES: 1, GL_LINE_LOOP: 2, GL_LINE_STRIP: 3, GL_TRIANGLES: 4, GL_TRIANGLE_STRIP: 5, GL_TRIANGLE_FAN: 6}


# ----------------------------------------------------------------------------- matrices (column-major, as OpenGL)

def _ident():
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def _mul(a, b):
    return [sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4)) for c in range(4) for r in range(4)]


def _apply(m, v):
    return [sum(m[k * 4 + r] * v[k] for k in range(4)) for r in range(4)]


def _normal_matrix(m):
    """The inverse transpose of the upper 3x3: what normals are multiplied by."""
    a, b, c, d, e, f, g, h, i = m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-30:
        return [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    inv = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
           (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
           (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]      # rows of the inverse
    # column-major of the transpose of the inverse = the inverse's rows as columns
    return [inv[0], inv[1], inv[2], inv[3], inv[4], inv[5], inv[6], inv[7], inv[8]]


def _floats(v, n=None):
    if hasattr(v, "tolist"):
        v = v.tolist()
    out = []
    stack = [v]
    while stack:
        x = stack.pop()
        if isinstance(x, (list, tuple)):
            stack.extend(reversed(x))
        else:
            out.append(float(x))
    if n is not None:
        out = (out + [0.0] * n)[:n]
    return out


# ----------------------------------------------------------------------------- the context

class _Light:
    def __init__(self, first):
        self.on = False
        self.ambient = [0.0, 0.0, 0.0, 1.0]
        self.diffuse = [1.0, 1.0, 1.0, 1.0] if first else [0.0, 0.0, 0.0, 1.0]
        self.specular = list(self.diffuse)
        self.position = [0.0, 0.0, 1.0, 0.0]         # in eye space, as OpenGL keeps it


class Context:
    """The state of one OpenGL context and the page's drawing object it sends to (None where there is no browser)."""

    def __init__(self, js=None):
        self.js = js
        self.mode = GL_MODELVIEW
        self.stacks = {GL_MODELVIEW: [_ident()], GL_PROJECTION: [_ident()], GL_TEXTURE: [_ident()]}
        self.color = [1.0, 1.0, 1.0, 1.0]
        self.normal = [0.0, 0.0, 1.0]
        self.uv = [0.0, 0.0]
        self.caps = {GL_DITHER: True, GL_MULTISAMPLE: True}
        self.lights = [_Light(i == 0) for i in range(8)]
        self.scene_ambient = [0.2, 0.2, 0.2, 1.0]
        self.material = {GL_AMBIENT: [0.2, 0.2, 0.2, 1.0], GL_DIFFUSE: [0.8, 0.8, 0.8, 1.0], GL_SPECULAR: [0.0, 0.0, 0.0, 1.0], GL_EMISSION: [0.0, 0.0, 0.0, 1.0]}
        self.shininess = 0.0
        self.polygon_mode = GL_FILL
        self.line_width = 1.0
        self.point_size = 1.0
        self.viewport = [0, 0, 1, 1]
        self.clear_color = [0.0, 0.0, 0.0, 0.0]
        self.arrays = {}            # GL_VERTEX_ARRAY -> (size, data, stride)
        self.client = set()
        self.begun = None
        self.im = None
        self.texture = 0
        self.textures = {}          # our name -> the page's
        self.next_texture = 1
        self.raster = [0.0, 0.0]
        self.lists = {}
        self.recording = None
        self.kept = {}
        self.draws = 0
        self.canvas_height = 0      # of the drawing buffer, in pixels (window coordinates start at its bottom)

    def top(self, which=None):
        return self.stacks[which or self.mode][-1]

    def enabled(self, cap):
        return bool(self.caps.get(cap))

    def send_state(self, **s):
        if self.js is not None:
            from pyodide.ffi import to_js
            import js
            self.js.state(js.Object.fromEntries(to_js([[k, v] for k, v in s.items()])))


_current = None
_headless = Context()        # calls made with no context current keep their state here and draw nothing


def _ctx():
    return _current if _current is not None else _headless


def _make_current(ctx):
    global _current
    _current = ctx


def _record(fn):
    """A call made while a display list is being compiled is kept for glCallList (and run, if the list asks for it)."""
    def call(*a, **k):
        c = _ctx()
        if c.recording is not None:
            c.lists[c.recording[0]].append((fn, a, k))
            if not c.recording[1]:
                return None
        return fn(*a, **k)
    call.__name__ = fn.__name__
    return call


# ----------------------------------------------------------------------------- state

_CAP_NAMES = {GL_DEPTH_TEST: "depthTest", GL_BLEND: "blend", GL_CULL_FACE: "cullFace", GL_POLYGON_OFFSET_FILL: "polygonOffsetFill"}


@_record
def glEnable(cap):
    c = _ctx()
    if GL_LIGHT0 <= cap <= GL_LIGHT0 + 7:
        c.lights[cap - GL_LIGHT0].on = True
        return
    c.caps[cap] = True
    if cap in _CAP_NAMES:
        c.send_state(**{_CAP_NAMES[cap]: True})


@_record
def glDisable(cap):
    c = _ctx()
    if GL_LIGHT0 <= cap <= GL_LIGHT0 + 7:
        c.lights[cap - GL_LIGHT0].on = False
        return
    c.caps[cap] = False
    if cap in _CAP_NAMES:
        c.send_state(**{_CAP_NAMES[cap]: False})


def glIsEnabled(cap):
    c = _ctx()
    if GL_LIGHT0 <= cap <= GL_LIGHT0 + 7:
        return c.lights[cap - GL_LIGHT0].on
    return c.enabled(cap)


@_record
def glDepthFunc(func):
    _ctx().send_state(depthFunc=int(func))


@_record
def glDepthMask(flag):
    _ctx().send_state(depthMask=bool(flag))


@_record
def glColorMask(r, g, b, a):
    _ctx().send_state(colorMask=[bool(r), bool(g), bool(b), bool(a)])


@_record
def glBlendFunc(src, dst):
    _ctx().send_state(blendFunc=[int(src), int(dst)])


@_record
def glCullFace(mode):
    _ctx().send_state(cullFaceMode=int(mode))


@_record
def glFrontFace(mode):
    _ctx().send_state(frontFace=int(mode))


@_record
def glPolygonOffset(factor, units):
    _ctx().send_state(polygonOffset=[float(factor), float(units)])


@_record
def glPolygonMode(face, mode):
    _ctx().polygon_mode = mode


@_record
def glLineWidth(width):
    c = _ctx()
    c.line_width = float(width)
    c.send_state(lineWidth=float(width))


@_record
def glPointSize(size):
    _ctx().point_size = float(size)


@_record
def glShadeModel(mode):
    pass


@_record
def glHint(target, mode):
    pass


@_record
def glViewport(x, y, w, h):
    c = _ctx()
    c.viewport = [int(x), int(y), int(w), int(h)]
    if c.js is not None:
        c.js.viewport(int(x), int(y), int(w), int(h))


@_record
def glScissor(x, y, w, h):
    c = _ctx()
    if c.js is not None:
        c.js.scissor(c.enabled(GL_SCISSOR_TEST), int(x), int(y), int(w), int(h))


@_record
def glClearColor(r, g, b, a):
    c = _ctx()
    c.clear_color = [float(r), float(g), float(b), float(a)]
    if c.js is not None:
        c.js.clearColor(float(r), float(g), float(b), float(a))


@_record
def glClearDepth(depth):
    pass


@_record
def glClear(mask):
    c = _ctx()
    if c.js is not None:
        c.js.clear(bool(mask & GL_COLOR_BUFFER_BIT), bool(mask & GL_DEPTH_BUFFER_BIT))


def glFlush():
    c = _ctx()
    if c.js is not None:
        c.js.finish()


glFinish = glFlush


def glGetError():
    return GL_NO_ERROR


def glGetString(name):
    return {GL_VENDOR: b"KiCad Collaborative", GL_RENDERER: b"WebGL (fixed-function OpenGL for plugins)", GL_VERSION: b"1.5 web", GL_EXTENSIONS: b"",
            GL_SHADING_LANGUAGE_VERSION: b""}.get(name, b"")


def glGetFloatv(name):
    c = _ctx()
    if name == GL_MODELVIEW_MATRIX:
        return _as_array(c.top(GL_MODELVIEW), (4, 4))
    if name == GL_PROJECTION_MATRIX:
        return _as_array(c.top(GL_PROJECTION), (4, 4))
    if name == GL_CURRENT_COLOR:
        return _as_array(c.color, None)
    if name == GL_LINE_WIDTH:
        return c.line_width
    if name == GL_VIEWPORT:
        return _as_array(c.viewport, None)
    return 0.0


glGetDoublev = glGetFloatv


def glGetIntegerv(name):
    c = _ctx()
    if name == GL_VIEWPORT:
        return _as_array(c.viewport, None, int)
    if name == GL_MAX_TEXTURE_SIZE:
        return 4096
    if name == GL_MAX_LIGHTS:
        return 8
    return 0


glGetInteger = glGetIntegerv
glGetFloat = glGetFloatv
glGetDouble = glGetFloatv


def _as_array(values, shape, kind=float):
    try:
        import numpy as np
        a = np.array(values, dtype=np.float32 if kind is float else np.int32)
        return a.reshape(shape) if shape else a
    except ImportError:
        return [kind(v) for v in values]


# ----------------------------------------------------------------------------- matrices

@_record
def glMatrixMode(mode):
    _ctx().mode = mode


@_record
def glLoadIdentity():
    _ctx().top()[:] = _ident()


@_record
def glLoadMatrixf(m):
    _ctx().top()[:] = _floats(m, 16)


glLoadMatrixd = glLoadMatrixf


@_record
def glMultMatrixf(m):
    t = _ctx().top()
    t[:] = _mul(t, _floats(m, 16))


glMultMatrixd = glMultMatrixf


@_record
def glPushMatrix():
    s = _ctx().stacks[_ctx().mode]
    s.append(list(s[-1]))


@_record
def glPopMatrix():
    s = _ctx().stacks[_ctx().mode]
    if len(s) > 1:
        s.pop()


@_record
def glTranslatef(x, y, z):
    m = _ident()
    m[12], m[13], m[14] = float(x), float(y), float(z)
    _mult(m)


def _mult(m):
    t = _ctx().top()
    t[:] = _mul(t, m)


@_record
def glScalef(x, y, z):
    m = _ident()
    m[0], m[5], m[10] = float(x), float(y), float(z)
    _mult(m)


@_record
def glRotatef(angle, x, y, z):
    n = _math.sqrt(x * x + y * y + z * z)
    if n == 0:
        return
    x, y, z = x / n, y / n, z / n
    c, s = _math.cos(_math.radians(angle)), _math.sin(_math.radians(angle))
    t = 1 - c
    _mult([t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0.0,
           t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0.0,
           t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0.0,
           0.0, 0.0, 0.0, 1.0])


glTranslated, glScaled, glRotated = glTranslatef, glScalef, glRotatef


@_record
def glOrtho(left, right, bottom, top, near, far):
    rl, tb, fn = float(right - left) or 1.0, float(top - bottom) or 1.0, float(far - near) or 1.0
    _mult([2 / rl, 0.0, 0.0, 0.0, 0.0, 2 / tb, 0.0, 0.0, 0.0, 0.0, -2 / fn, 0.0, -(right + left) / rl, -(top + bottom) / tb, -(far + near) / fn, 1.0])


@_record
def glFrustum(left, right, bottom, top, near, far):
    rl, tb, fn = float(right - left) or 1.0, float(top - bottom) or 1.0, float(far - near) or 1.0
    _mult([2 * near / rl, 0.0, 0.0, 0.0, 0.0, 2 * near / tb, 0.0, 0.0, (right + left) / rl, (top + bottom) / tb, -(far + near) / fn, -1.0, 0.0, 0.0, -2 * far * near / fn, 0.0])


# ----------------------------------------------------------------------------- lights and material

@_record
def glLightfv(light, name, params):
    c = _ctx()
    l = c.lights[light - GL_LIGHT0]
    v = _floats(params)
    if name == GL_POSITION:
        l.position = _apply(c.top(GL_MODELVIEW), (v + [0.0, 0.0, 1.0, 0.0])[:4] if len(v) < 4 else v[:4])
    elif name == GL_AMBIENT:
        l.ambient = (v + [1.0])[:4]
    elif name == GL_DIFFUSE:
        l.diffuse = (v + [1.0])[:4]
    elif name == GL_SPECULAR:
        l.specular = (v + [1.0])[:4]


glLightf = glLighti = glLightiv = glLightfv


@_record
def glLightModelfv(name, params):
    if name == GL_LIGHT_MODEL_AMBIENT:
        _ctx().scene_ambient = (_floats(params) + [1.0])[:4]


glLightModelf = glLightModeli = glLightModeliv = glLightModelfv


@_record
def glMaterialfv(face, name, params):
    c = _ctx()
    v = _floats(params)
    if name == GL_SHININESS:
        c.shininess = v[0] if v else 0.0
    elif name == GL_AMBIENT_AND_DIFFUSE:
        c.material[GL_AMBIENT] = (v + [1.0])[:4]
        c.material[GL_DIFFUSE] = (v + [1.0])[:4]
    elif name in c.material:
        c.material[name] = (v + [1.0])[:4]


glMaterialf = glMateriali = glMaterialiv = glMaterialfv


@_record
def glColorMaterial(face, mode):
    pass


# ----------------------------------------------------------------------------- current vertex attributes

@_record
def glColor4f(r, g, b, a=1.0):
    c = _ctx()
    c.color = [float(r), float(g), float(b), float(a)]


def glColor3f(r, g, b):
    glColor4f(r, g, b, 1.0)


glColor3d, glColor4d = glColor3f, glColor4f


def glColor3ub(r, g, b):
    glColor4f(r / 255.0, g / 255.0, b / 255.0, 1.0)


def glColor4ub(r, g, b, a):
    glColor4f(r / 255.0, g / 255.0, b / 255.0, a / 255.0)


def glColor3fv(v):
    v = _floats(v)
    glColor4f(*(v + [1.0])[:4])


glColor4fv = glColor3dv = glColor4dv = glColor3fv


def glColor(*a):
    glColor3fv(a[0] if len(a) == 1 else a)


@_record
def glNormal3f(x, y, z):
    _ctx().normal = [float(x), float(y), float(z)]


glNormal3d = glNormal3f


def glNormal3fv(v):
    glNormal3f(*_floats(v, 3))


glNormal3dv = glNormal3fv


@_record
def glTexCoord2f(s, t):
    _ctx().uv = [float(s), float(t)]


glTexCoord2d = glTexCoord2f


def glTexCoord2fv(v):
    glTexCoord2f(*_floats(v, 2))


@_record
def glRasterPos2f(x, y):
    c = _ctx()
    c.raster = [float(x), float(y), 0.0]


glRasterPos2i = glRasterPos2d = glRasterPos2f


@_record
def glRasterPos3f(x, y, z):
    _ctx().raster = [float(x), float(y), float(z)]


glRasterPos3d = glRasterPos3f


def _window_pos(c, p):
    """Where an object-space point lands on the canvas, in pixels from its top left."""
    v = _apply(c.top(GL_PROJECTION), _apply(c.top(GL_MODELVIEW), [p[0], p[1], p[2] if len(p) > 2 else 0.0, 1.0]))
    w = v[3] or 1.0
    x, y, vw, vh = c.viewport
    height = c.canvas_height or (y + vh)
    return x + (v[0] / w * 0.5 + 0.5) * vw, height - (y + (v[1] / w * 0.5 + 0.5) * vh)


# ----------------------------------------------------------------------------- glBegin / glEnd

@_record
def glBegin(mode):
    c = _ctx()
    c.begun = mode
    c.im = {"pos": [], "normal": [], "color": [], "uv": [], "colored": False, "c0": list(c.color)}


@_record
def glVertex3f(x, y, z=0.0):
    c = _ctx()
    im = c.im
    if im is None:
        return
    im["pos"] += (float(x), float(y), float(z))
    im["normal"] += c.normal
    im["color"] += c.color
    im["uv"] += c.uv
    if c.color != im["c0"]:
        im["colored"] = True


def glVertex2f(x, y):
    glVertex3f(x, y, 0.0)


glVertex2d = glVertex2i = glVertex2f
glVertex3d = glVertex3i = glVertex3f


def glVertex3fv(v):
    glVertex3f(*_floats(v, 3))


glVertex3dv = glVertex3fv


def glVertex2fv(v):
    glVertex2f(*_floats(v, 2))


def glVertex(*a):
    v = _floats(a[0] if len(a) == 1 else a)
    glVertex3f(*(v + [0.0])[:3])


@_record
def glEnd():
    c = _ctx()
    im, mode = c.im, c.begun
    c.im = c.begun = None
    if not im or not im["pos"]:
        return
    n = len(im["pos"]) // 3
    _draw(c, mode, n, im["pos"], im["normal"], im["color"] if im["colored"] else None, im["uv"] if c.enabled(GL_TEXTURE_2D) else None)


def _expand(mode, n):
    """Vertex order that draws quads, quad strips and polygons as triangles (WebGL has none of them)."""
    if mode == GL_QUADS:
        return GL_TRIANGLES, [k for q in range(n // 4) for k in (q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3)]
    if mode == GL_QUAD_STRIP:
        return GL_TRIANGLES, [k for q in range(max(0, n // 2 - 1)) for k in (q * 2, q * 2 + 1, q * 2 + 3, q * 2, q * 2 + 3, q * 2 + 2)]
    if mode == GL_POLYGON:
        return GL_TRIANGLE_FAN, None
    return mode, None


def _outline(mode, n):
    """Vertex order that draws the edges of filled shapes (glPolygonMode GL_LINE)."""
    out = []
    if mode == GL_TRIANGLES:
        for t in range(n // 3):
            a = t * 3
            out += [a, a + 1, a + 1, a + 2, a + 2, a]
    elif mode == GL_QUADS:
        for q in range(n // 4):
            a = q * 4
            out += [a, a + 1, a + 1, a + 2, a + 2, a + 3, a + 3, a]
    elif mode in (GL_POLYGON, GL_TRIANGLE_FAN, GL_TRIANGLE_STRIP, GL_QUAD_STRIP):
        for i in range(n):
            out += [i, (i + 1) % n]
    else:
        return mode, None
    return GL_LINES, out


def _pick(values, size, order):
    return [values[i * size + k] for i in order for k in range(size)]


def _draw(c, mode, n, pos, normal=None, color=None, uv=None, keep=None):
    """One draw call to the page.  `pos` and the rest are flat lists (or typed data the page already keeps, by name)."""
    c.draws += 1
    if c.js is None or n <= 0:
        return
    order = None
    if c.polygon_mode == GL_LINE and mode >= GL_TRIANGLES:
        mode, order = _outline(mode, n)
    elif c.polygon_mode == GL_POINT and mode >= GL_TRIANGLES:
        mode = GL_POINTS
    else:
        mode, order = _expand(mode, n)
    if order is not None:
        if keep:
            keep = None
        pos = _pick(_plain(pos), 3, order)
        normal = _pick(_plain(normal), 3, order) if normal is not None else None
        color = _pick(_plain(color), 4, order) if color is not None else None
        uv = _pick(_plain(uv), 2, order) if uv is not None else None
        n = len(order)
    import js
    from pyodide.ffi import to_js
    mv, p = c.top(GL_MODELVIEW), c.top(GL_PROJECTION)
    lit = c.enabled(GL_LIGHTING)
    call = {"mode": _WEBGL_MODE.get(mode, 0), "count": int(n), "mv": mv, "p": p, "n": _normal_matrix(mv), "rgba": c.color, "lit": lit, "pointSize": c.point_size}
    if lit:
        lights = []
        for l in c.lights:
            if l.on:
                lights += l.position + l.ambient + l.diffuse + l.specular
        call.update(lights=lights, colorMaterial=c.enabled(GL_COLOR_MATERIAL), normalize=c.enabled(GL_NORMALIZE) or c.enabled(GL_RESCALE_NORMAL), ambient=c.material[GL_AMBIENT],
                    diffuse=c.material[GL_DIFFUSE], specular=c.material[GL_SPECULAR], emission=c.material[GL_EMISSION], shininess=c.shininess, sceneAmbient=c.scene_ambient)
    if uv is not None and c.enabled(GL_TEXTURE_2D) and c.texture in c.textures:
        call["texture"] = c.textures[c.texture]
    obj = js.Object.fromEntries(to_js([[k, v] for k, v in call.items()]))
    f32 = js.Float32Array
    obj.pos = keep["pos"] if keep and keep.get("pos") else f32.new(to_js(_plain(pos)))
    if lit and keep and keep.get("normal"):
        obj.normal = keep["normal"]
    elif lit and normal is not None:
        obj.normal = f32.new(to_js(_plain(normal)))
    if color is not None:
        obj.color = f32.new(to_js(_plain(color)))
    if "texture" in call:
        obj.uv = f32.new(to_js(_plain(uv)))
    c.js.draw(obj)


def _plain(v):
    if v is None or isinstance(v, list):
        return v
    if hasattr(v, "ravel"):
        return v.ravel().tolist()
    return _floats(v)


# ----------------------------------------------------------------------------- vertex arrays

def glEnableClientState(array):
    _ctx().client.add(array)


def glDisableClientState(array):
    _ctx().client.discard(array)


def glVertexPointer(size, type, stride, pointer):
    _ctx().arrays[GL_VERTEX_ARRAY] = (int(size), pointer)


def glNormalPointer(type, stride, pointer):
    _ctx().arrays[GL_NORMAL_ARRAY] = (3, pointer)


def glColorPointer(size, type, stride, pointer):
    _ctx().arrays[GL_COLOR_ARRAY] = (int(size), pointer)


def glTexCoordPointer(size, type, stride, pointer):
    _ctx().arrays[GL_TEXTURE_COORD_ARRAY] = (int(size), pointer)


glVertexPointerf = lambda pointer: glVertexPointer(3, GL_FLOAT, 0, pointer)
glNormalPointerf = lambda pointer: glNormalPointer(GL_FLOAT, 0, pointer)
glColorPointerf = lambda pointer: glColorPointer(4, GL_FLOAT, 0, pointer)


def _signature(a):
    """Something that changes when a numpy array's contents do, cheap enough to ask every frame."""
    try:
        flat = a.reshape(-1)
        step = max(1, flat.size // 64)
        return (a.__array_interface__["data"][0], flat.size, float(flat[::step].sum()), float(flat[-1]) if flat.size else 0.0)
    except Exception:
        return None


def _kept(c, which, size, data, first, count):
    """A large numpy array drawn whole is put on the graphics card once and named from then on."""
    if c.js is None or not hasattr(data, "__array_interface__") or first != 0 or size != 3 or data.size < 3000 or data.size != count * 3:
        return None
    sig = _signature(data)
    if sig is None:
        return None
    name = "%s:%d" % (which, sig[0])
    if c.kept.get(name) != sig or not c.js.has(name):
        import numpy as np
        from pyodide.ffi import to_js
        c.js.keep(name, to_js(np.ascontiguousarray(data, dtype=np.float32).reshape(-1)))
        c.kept[name] = sig
        if len(c.kept) > 16:        # meshes that were replaced
            for old in list(c.kept)[:-16]:
                c.js.drop(old)
                del c.kept[old]
    return name


def _slice(entry, first, count, want):
    """`count` vertices from a client array as a flat list with `want` numbers each."""
    size, data = entry
    flat = _plain(data)
    out = flat[first * size:(first + count) * size]
    if size == want:
        return out
    pad = [0.0, 0.0, 0.0, 1.0]
    return [(out[i * size + k] if k < size else pad[k]) for i in range(count) for k in range(want)]


@_record
def glDrawArrays(mode, first, count):
    c = _ctx()
    if GL_VERTEX_ARRAY not in c.client or GL_VERTEX_ARRAY not in c.arrays or count <= 0:
        return
    if c.js is None:
        c.draws += 1
        return
    va = c.arrays[GL_VERTEX_ARRAY]
    na = c.arrays.get(GL_NORMAL_ARRAY) if GL_NORMAL_ARRAY in c.client else None
    ca = c.arrays.get(GL_COLOR_ARRAY) if GL_COLOR_ARRAY in c.client else None
    ta = c.arrays.get(GL_TEXTURE_COORD_ARRAY) if GL_TEXTURE_COORD_ARRAY in c.client else None
    plain = c.polygon_mode == GL_FILL and mode in _WEBGL_MODE
    keep = None
    if plain and ca is None and ta is None:
        kp = _kept(c, "v", va[0], va[1], first, count)
        if kp:
            keep = {"pos": kp, "normal": _kept(c, "n", 3, na[1], first, count) if na is not None and c.enabled(GL_LIGHTING) else None}
    if keep:
        _draw(c, mode, count, None, _slice(na, first, count, 3) if na is not None and not keep.get("normal") else None, None, None, keep)
        return
    _draw(c, mode, count, _slice(va, first, count, 3), _slice(na, first, count, 3) if na is not None else None,
          _slice(ca, first, count, 4) if ca is not None else None, _slice(ta, first, count, 2) if ta is not None else None)


@_record
def glDrawElements(mode, count, type, indices):
    c = _ctx()
    if GL_VERTEX_ARRAY not in c.client or GL_VERTEX_ARRAY not in c.arrays:
        return
    order = [int(i) for i in _plain(indices)][:int(count)]
    def take(which, want):
        e = c.arrays.get(which) if which in c.client else None
        if e is None:
            return None
        size, data = e
        flat = _plain(data)
        pad = [0.0, 0.0, 0.0, 1.0]
        return [(flat[i * size + k] if k < size else pad[k]) for i in order for k in range(want)]
    _draw(c, mode, len(order), take(GL_VERTEX_ARRAY, 3), take(GL_NORMAL_ARRAY, 3), take(GL_COLOR_ARRAY, 4), take(GL_TEXTURE_COORD_ARRAY, 2))


# ----------------------------------------------------------------------------- textures

def glGenTextures(n=1):
    c = _ctx()
    names = []
    for _ in range(int(n)):
        name = c.next_texture
        c.next_texture += 1
        if c.js is not None:
            c.textures[name] = int(c.js.texture())
        names.append(name)
    return names[0] if int(n) == 1 else names


def glDeleteTextures(*a):
    c = _ctx()
    names = a[-1] if a else []
    for name in ([names] if isinstance(names, int) else list(_plain(names) if hasattr(names, "tolist") else names)):
        page = c.textures.pop(int(name), None)
        if page is not None and c.js is not None:
            c.js.deleteTexture(page)


@_record
def glBindTexture(target, texture):
    _ctx().texture = int(texture or 0)


def glTexImage2D(target, level, internal, width, height, border, format, type, pixels):
    c = _ctx()
    if c.js is None or c.texture not in c.textures or level != 0:
        return
    channels = {GL_RGBA: 4, GL_BGRA: 4, GL_RGB: 3, GL_BGR: 3, GL_LUMINANCE_ALPHA: 2}.get(format, 1)
    data = None
    if pixels is not None:
        if hasattr(pixels, "tobytes"):
            raw = pixels.tobytes() if type == GL_UNSIGNED_BYTE or str(getattr(pixels, "dtype", "uint8")) == "uint8" else bytes(int(max(0.0, min(1.0, float(v))) * 255) for v in pixels.ravel().tolist())
        else:
            raw = bytes(pixels)
        if format in (GL_BGR, GL_BGRA):
            b = bytearray(raw)
            b[0::channels], b[2::channels] = raw[2::channels], raw[0::channels]
            raw = bytes(b)
        from pyodide.ffi import to_js
        data = to_js(raw[:int(width) * int(height) * channels])
    c.js.texImage(c.textures[c.texture], int(width), int(height), channels, data)


def glTexParameteri(target, name, value):
    c = _ctx()
    if c.js is None or c.texture not in c.textures:
        return
    if name in (GL_TEXTURE_MIN_FILTER, GL_TEXTURE_MAG_FILTER):
        c.js.texFilter(c.textures[c.texture], name == GL_TEXTURE_MIN_FILTER, value not in (GL_NEAREST, GL_NEAREST_MIPMAP_NEAREST))


glTexParameterf = glTexParameteri


def glTexEnvf(*a):
    pass


glTexEnvi = glPixelStorei = glPixelStoref = glTexEnvf


def glReadPixels(x, y, width, height, format, type, *a):
    c = _ctx()
    if c.js is None:
        return bytes(int(width) * int(height) * (4 if format in (GL_RGBA, GL_BGRA) else 3))
    raw = bytes(c.js.pixels(int(x), int(y), int(width), int(height)).to_py())
    if format in (GL_RGB, GL_BGR):
        out = bytearray(int(width) * int(height) * 3)
        out[0::3], out[1::3], out[2::3] = raw[0::4], raw[1::4], raw[2::4]
        raw = bytes(out)
    return raw


# ----------------------------------------------------------------------------- display lists, attribute stacks

def glGenLists(n):
    c = _ctx()
    first = max(c.lists, default=0) + 1
    for i in range(int(n)):
        c.lists[first + i] = []
    return first


def glNewList(name, mode):
    c = _ctx()
    c.lists[name] = []
    c.recording = (name, mode == GL_COMPILE_AND_EXECUTE)


def glEndList():
    _ctx().recording = None


def glCallList(name):
    for fn, a, k in list(_ctx().lists.get(name, [])):
        fn(*a, **k)


def glCallLists(names):
    for name in names:
        glCallList(name)


def glDeleteLists(first, n):
    for i in range(int(n)):
        _ctx().lists.pop(first + i, None)


def glIsList(name):
    return name in _ctx().lists


_attrib_stack = []


def glPushAttrib(mask):
    c = _ctx()
    _attrib_stack.append((dict(c.caps), list(c.color), c.polygon_mode, c.line_width, [l.on for l in c.lights]))


def glPopAttrib():
    if not _attrib_stack:
        return
    c = _ctx()
    caps, color, mode, width, lights = _attrib_stack.pop()
    for cap, name in _CAP_NAMES.items():
        if bool(caps.get(cap)) != bool(c.caps.get(cap)):
            c.send_state(**{name: bool(caps.get(cap))})
    c.caps, c.color, c.polygon_mode = caps, color, mode
    glLineWidth(width)
    for l, on in zip(c.lights, lights):
        l.on = on


glPushClientAttrib = glPopClientAttrib = lambda *a: None
glLineStipple = glAlphaFunc = glStencilFunc = glStencilOp = glStencilMask = glClearStencil = glFogf = glFogi = glFogfv = glDepthRange = glAccum = glClearAccum = lambda *a: None

__all__ = [n for n in dir() if n.startswith(("gl", "GL_"))]
