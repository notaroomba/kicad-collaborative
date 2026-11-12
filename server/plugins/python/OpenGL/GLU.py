"""OpenGL.GLU: the camera helpers, as matrices multiplied onto the current stack (see OpenGL/__init__.py)."""

import math as _math

from . import GL as _GL

GLU_SMOOTH, GLU_FLAT, GLU_NONE, GLU_FILL, GLU_LINE, GLU_POINT, GLU_SILHOUETTE = 100000, 100001, 100002, 100012, 100011, 100010, 100013


def gluPerspective(fovy, aspect, near, far):
    f = 1.0 / _math.tan(_math.radians(fovy) / 2.0)
    nf = float(near - far) or -1.0
    _GL.glMultMatrixf([f / (aspect or 1.0), 0.0, 0.0, 0.0, 0.0, f, 0.0, 0.0, 0.0, 0.0, (far + near) / nf, -1.0, 0.0, 0.0, 2.0 * far * near / nf, 0.0])


def gluLookAt(ex, ey, ez, cx, cy, cz, ux, uy, uz):
    f = [cx - ex, cy - ey, cz - ez]
    n = _math.sqrt(sum(v * v for v in f)) or 1.0
    f = [v / n for v in f]
    s = [f[1] * uz - f[2] * uy, f[2] * ux - f[0] * uz, f[0] * uy - f[1] * ux]
    n = _math.sqrt(sum(v * v for v in s)) or 1.0
    s = [v / n for v in s]
    u = [s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0]]
    _GL.glMultMatrixf([s[0], u[0], -f[0], 0.0, s[1], u[1], -f[1], 0.0, s[2], u[2], -f[2], 0.0, 0.0, 0.0, 0.0, 1.0])
    _GL.glTranslatef(-ex, -ey, -ez)


def gluOrtho2D(left, right, bottom, top):
    _GL.glOrtho(left, right, bottom, top, -1.0, 1.0)


def gluProject(x, y, z, model=None, proj=None, view=None):
    c = _GL._ctx()
    m = _GL._floats(model, 16) if model is not None else c.top(_GL.GL_MODELVIEW)
    p = _GL._floats(proj, 16) if proj is not None else c.top(_GL.GL_PROJECTION)
    vp = [int(v) for v in (view if view is not None else c.viewport)]
    v = _GL._apply(p, _GL._apply(m, [x, y, z, 1.0]))
    w = v[3] or 1.0
    return (vp[0] + (v[0] / w * 0.5 + 0.5) * vp[2], vp[1] + (v[1] / w * 0.5 + 0.5) * vp[3], v[2] / w * 0.5 + 0.5)


class _Quadric:
    def __init__(self):
        self.style, self.normals = GLU_FILL, GLU_SMOOTH


def gluNewQuadric():
    return _Quadric()


def gluDeleteQuadric(q):
    pass


def gluQuadricDrawStyle(q, style):
    q.style = style


def gluQuadricNormals(q, normals):
    q.normals = normals


gluQuadricTexture = gluQuadricOrientation = lambda q, v: None


def gluSphere(q, radius, slices, stacks):
    G = _GL
    mode = G.GL_LINE_LOOP if getattr(q, "style", GLU_FILL) in (GLU_LINE, GLU_SILHOUETTE) else G.GL_QUADS
    for i in range(int(stacks)):
        a0, a1 = _math.pi * (i / stacks - 0.5), _math.pi * ((i + 1) / stacks - 0.5)
        for j in range(int(slices)):
            b0, b1 = 2 * _math.pi * j / slices, 2 * _math.pi * (j + 1) / slices
            G.glBegin(mode)
            for a, b in ((a0, b0), (a0, b1), (a1, b1), (a1, b0)):
                n = (_math.cos(a) * _math.cos(b), _math.cos(a) * _math.sin(b), _math.sin(a))
                G.glNormal3f(*n)
                G.glVertex3f(n[0] * radius, n[1] * radius, n[2] * radius)
            G.glEnd()


def gluCylinder(q, base, top, height, slices, stacks):
    G = _GL
    for j in range(int(slices)):
        b0, b1 = 2 * _math.pi * j / slices, 2 * _math.pi * (j + 1) / slices
        G.glBegin(G.GL_QUADS)
        for b, z, r in ((b0, 0.0, base), (b1, 0.0, base), (b1, height, top), (b0, height, top)):
            G.glNormal3f(_math.cos(b), _math.sin(b), 0.0)
            G.glVertex3f(_math.cos(b) * r, _math.sin(b) * r, z)
        G.glEnd()


def gluDisk(q, inner, outer, slices, loops):
    G = _GL
    for j in range(int(slices)):
        b0, b1 = 2 * _math.pi * j / slices, 2 * _math.pi * (j + 1) / slices
        G.glBegin(G.GL_QUADS)
        G.glNormal3f(0.0, 0.0, 1.0)
        for b, r in ((b0, inner), (b0, outer), (b1, outer), (b1, inner)):
            G.glVertex3f(_math.cos(b) * r, _math.sin(b) * r, 0.0)
        G.glEnd()


__all__ = [n for n in dir() if n.startswith(("glu", "GLU_"))]
