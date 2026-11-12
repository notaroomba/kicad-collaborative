"""PyOpenGL for KiCad plugins in the web editor: the OpenGL 1.x calls a plugin draws a 3D preview with, on WebGL.

`OpenGL.GL`, `OpenGL.GLU` and `OpenGL.GLUT` hold the fixed-function state here (matrix stacks, lights, material,
client arrays, glBegin/glEnd) and hand finished draw calls to the browser (web/plugins/glfixed.ts), which draws
them with one shader pair that does what the fixed pipeline did.  A context comes from wx.glcanvas.GLCanvas.
"""

__version__ = "3.1.7"
ERROR_CHECKING = False
ERROR_LOGGING = False
FULL_LOGGING = False
UNSIGNED_BYTE_IMAGES_AS_STRING = True


class error:
    class Error(Exception):
        pass

    class GLError(Error):
        def __init__(self, err=None, result=None, cArguments=None, baseOperation=None, pyArgs=None, description=None):
            Exception.__init__(self, description or err)
            self.err, self.description = err, description

    class NullFunctionError(Error):
        pass

    class NoContext(Error):
        pass
