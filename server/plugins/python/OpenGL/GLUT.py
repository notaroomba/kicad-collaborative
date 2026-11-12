"""OpenGL.GLUT: what plugins use of it inside a wx window: bitmap text (see OpenGL/__init__.py).  GLUT's own windows
and main loop have no place in a plugin's panel; the wx canvas gives the context."""

from . import GL as _GL

GLUT_RGB = GLUT_RGBA = 0
GLUT_DOUBLE, GLUT_DEPTH, GLUT_ALPHA, GLUT_MULTISAMPLE = 2, 16, 8, 128

# a font is (pixels high, CSS family, advance in pixels for a fixed-width one)
GLUT_BITMAP_9_BY_15 = (15, "monospace", 9)
GLUT_BITMAP_8_BY_13 = (13, "monospace", 8)
GLUT_BITMAP_TIMES_ROMAN_10 = (10, "serif", None)
GLUT_BITMAP_TIMES_ROMAN_24 = (24, "serif", None)
GLUT_BITMAP_HELVETICA_10 = (10, "sans-serif", None)
GLUT_BITMAP_HELVETICA_12 = (12, "sans-serif", None)
GLUT_BITMAP_HELVETICA_18 = (18, "sans-serif", None)


def glutInit(*a):
    return list(a[0]) if a else []


def glutInitDisplayMode(*a):
    pass


def glutBitmapWidth(font, character):
    return font[2] or int(font[0] * 0.55)


def glutBitmapLength(font, text):
    return sum(glutBitmapWidth(font, ch) for ch in (text.decode("latin-1") if isinstance(text, bytes) else str(text)))


def glutBitmapCharacter(font, character):
    """One character at the raster position, which then moves on by the character's width."""
    c = _GL._ctx()
    ch = chr(character) if isinstance(character, int) else str(character)
    if c.js is not None:
        x, y = _GL._window_pos(c, c.raster)
        from pyodide.ffi import to_js
        c.js.text(x, y, ch, font[0] - 2 if font[2] else font[0], font[1], to_js(c.color))
    # the raster position is kept in object space: step it by the character's width in pixels
    adv = glutBitmapWidth(font, ch)
    mv, p = c.top(_GL.GL_MODELVIEW), c.top(_GL.GL_PROJECTION)
    sx = abs(_GL._mul(p, mv)[0]) * c.viewport[2] / 2.0 or 1.0
    c.raster = [c.raster[0] + adv / sx, c.raster[1]] + list(c.raster[2:])


def glutBitmapString(font, text):
    for ch in (text.decode("latin-1") if isinstance(text, bytes) else str(text)):
        glutBitmapCharacter(font, ord(ch))


def glutSwapBuffers():
    pass


glutPostRedisplay = glutSwapBuffers


def glutGet(*a):
    return 0


def glutSolidCube(size):
    G = _GL
    h = size / 2.0
    for n, quad in (((0, 0, 1), ((-h, -h, h), (h, -h, h), (h, h, h), (-h, h, h))), ((0, 0, -1), ((-h, -h, -h), (-h, h, -h), (h, h, -h), (h, -h, -h))),
                    ((1, 0, 0), ((h, -h, -h), (h, h, -h), (h, h, h), (h, -h, h))), ((-1, 0, 0), ((-h, -h, -h), (-h, -h, h), (-h, h, h), (-h, h, -h))),
                    ((0, 1, 0), ((-h, h, -h), (-h, h, h), (h, h, h), (h, h, -h))), ((0, -1, 0), ((-h, -h, -h), (h, -h, -h), (h, -h, h), (-h, -h, h)))):
        G.glBegin(G.GL_QUADS)
        G.glNormal3f(*n)
        for v in quad:
            G.glVertex3f(*v)
        G.glEnd()


def glutWireCube(size):
    G = _GL
    was = G._ctx().polygon_mode
    G.glPolygonMode(G.GL_FRONT_AND_BACK, G.GL_LINE)
    glutSolidCube(size)
    G.glPolygonMode(G.GL_FRONT_AND_BACK, was)


__all__ = [n for n in dir() if n.startswith(("glut", "GLUT_"))]
