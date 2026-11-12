"""wx.glcanvas: a window with an OpenGL context.  The context is the OpenGL shim's (plugins/python/OpenGL), which
draws on a WebGL canvas inside this window's element."""

import wx
from wx import _paint

WX_GL_RGBA, WX_GL_BUFFER_SIZE, WX_GL_LEVEL, WX_GL_DOUBLEBUFFER, WX_GL_STEREO, WX_GL_AUX_BUFFERS = 1, 2, 3, 4, 5, 6
WX_GL_MIN_RED, WX_GL_MIN_GREEN, WX_GL_MIN_BLUE, WX_GL_MIN_ALPHA, WX_GL_DEPTH_SIZE, WX_GL_STENCIL_SIZE = 7, 8, 9, 10, 11, 12
WX_GL_MIN_ACCUM_RED, WX_GL_MIN_ACCUM_GREEN, WX_GL_MIN_ACCUM_BLUE, WX_GL_MIN_ACCUM_ALPHA, WX_GL_SAMPLE_BUFFERS, WX_GL_SAMPLES = 13, 14, 15, 16, 17, 18
WX_GL_CORE_PROFILE, WX_GL_MAJOR_VERSION, WX_GL_MINOR_VERSION, WX_GL_COMPAT_PROFILE = 19, 20, 21, 22


class GLAttributes:
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: self


GLContextAttrs = GLAttributes


class GLContext:
    def __init__(self, win=None, other=None, *a, **k):
        self._win = win

    def SetCurrent(self, win=None):
        (win or self._win).SetCurrent(self)
        return True

    def IsOK(self):
        return True


class GLCanvas(wx.Window):
    def __init__(self, parent=None, *a, **k):
        for name in ("attribList", "dispAttrs", "palette"):
            k.pop(name, None)
        a = tuple(x for x in a if not isinstance(x, (GLAttributes, list)))
        wx.Window.__init__(self, parent, *a, **k)
        d = self.__dict__
        d["_gl_ctx"] = None
        d["_gl_canvas"] = None

    def _gl_context(self):
        """The OpenGL state of this canvas, with the page's WebGL drawing object once there is a page."""
        d = self.__dict__
        if d["_gl_ctx"] is None:
            from OpenGL import GL
            page = None
            if wx._DOM:
                import js
                gl = getattr(js, "__kcGL", None)
                if gl is None:
                    import os
                    src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "kicad_gl.js")
                    if os.path.isfile(src):
                        el = js.document.createElement("script")
                        with open(src, encoding="utf-8") as fh:
                            el.textContent = fh.read()
                        js.document.head.appendChild(el)
                        gl = getattr(js, "__kcGL", None)
                if gl is not None:
                    c = wx._el("canvas", "wx-gl")
                    c.style.cssText = "display:block;position:absolute;left:0;top:0;width:100%;height:100%"
                    self.el.style.position = "relative"
                    self.el.style.overflow = "hidden"
                    self.el.appendChild(c)
                    d["_gl_canvas"] = c
                    try:
                        page = gl.create(c)
                    except Exception as e:      # no WebGL in this browser: the plugin's calls keep their state and draw nothing
                        import logging
                        logging.getLogger("kicad_web").warning("This browser gave no WebGL context for the plugin's 3D view: %s", str(e).splitlines()[-1] if str(e) else e)
                        c.remove()
                        d["_gl_canvas"] = None
            d["_gl_ctx"] = GL.Context(page)
        return d["_gl_ctx"]

    def SetCurrent(self, context=None):
        from OpenGL import GL
        ctx = self._gl_context()
        if ctx.js is not None:
            # the drawing buffer follows the window: glViewport is given in its pixels
            w, h = self.GetSize()
            scale = self.GetContentScaleFactor()
            ctx.js.resize(int(w * scale), int(h * scale))
            ctx.canvas_height = int(h * scale)
        GL._make_current(ctx)
        return True

    def SwapBuffers(self):
        ctx = self.__dict__.get("_gl_ctx")
        if ctx is not None and ctx.js is not None:
            ctx.js.finish()
        return True

    def IsDisplaySupported(*a, **k):
        return True

    IsExtensionSupported = staticmethod(lambda *a: False)

    def GetContentScaleFactor(self):
        if wx._DOM:
            try:
                import js
                return float(js.devicePixelRatio or 1.0)
            except Exception:
                pass
        return 1.0

    GetDPIScaleFactor = GetContentScaleFactor

    def Destroy(self):
        from OpenGL import GL
        ctx = self.__dict__.get("_gl_ctx")
        if ctx is not None and GL._current is ctx:
            GL._make_current(None)
        return wx.Window.Destroy(self)


GLCanvasWithContext = GLCanvas
