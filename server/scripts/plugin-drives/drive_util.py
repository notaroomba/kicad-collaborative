"""Helpers for the drive scripts beside this file: find a plugin's widgets and work them as a person would."""
import wx


def windows():
    return [w for w in wx._top_windows if getattr(w, "_wx_visible", False)]


def walk(root=None):
    roots = [root] if root is not None else windows()
    for r in roots:
        stack = [r]
        while stack:
            w = stack.pop(0)
            yield w
            stack[0:0] = list(getattr(w, "_wx_children", []))


def _has(w, name):
    # not getattr: the widgets note every attribute a plugin asks for that they lack
    return any(name in vars(c) for c in type(w).__mro__)


def label_of(w):
    for name in ("GetLabel", "text", "GetTitle", "windowTitle"):
        f = getattr(w, name) if _has(w, name) else None
        if callable(f):
            try:
                t = f()
                if isinstance(t, str) and t:
                    return t.replace("&", "").strip()
            except Exception:
                pass
    return ""


def find_all(kind=None, label=None, root=None):
    out = []
    for w in walk(root):
        if kind is not None and not isinstance(w, kind):
            continue
        if label is not None and label.lower() not in label_of(w).lower():
            continue
        out.append(w)
    return out


def find(kind=None, label=None, root=None):
    hits = find_all(kind, label, root)
    if not hits:
        raise AssertionError("the plugin's window has no %s%s; it has: %s" % (
            getattr(kind, "__name__", "widget"), " labelled “%s”" % label if label else "",
            ", ".join(sorted({"%s “%s”" % (type(w).__name__, label_of(w)[:30]) for w in walk(root) if label_of(w)}))[:900]))
    return hits[0]


def click(label, root=None):
    """Press the button with this label (the first whose label contains it, an exact match first)."""
    hits = [b for b in find_all(wx.Button, label, root) if b.IsEnabled()]
    exact = [b for b in hits if label_of(b).lower() == label.lower()]
    if not hits:
        find(wx.Button, label, root)
        raise AssertionError("the button “%s” is switched off" % label)
    (exact or hits)[0]._wx_clicked()


def texts(root=None):
    """Everything a person could read in the plugin's windows."""
    out = []
    for w in walk(root):
        for name in ("GetLabel", "GetValue", "toPlainText", "text"):
            f = getattr(w, name) if _has(w, name) else None
            if callable(f):
                try:
                    t = f()
                except Exception:
                    continue
                if isinstance(t, str) and t.strip():
                    out.append(t.strip())
    return out


_said = []


def _listen():
    """Keep what the plugin tells the person in message boxes, which the editor shows and this run answers."""
    import kicad_web
    real = kicad_web._WxBridge.confirm
    if getattr(real, "_kc_heard", False):
        return

    def confirm(self, title, message, *a, **k):
        _said.append("%s: %s" % (title, message))
        return real(self, title, message, *a, **k)
    confirm._kc_heard = True
    kicad_web._WxBridge.confirm = confirm


_listen()


def messages():
    return [str(m[1] if isinstance(m, tuple) else m) for m in wx._messages] + list(_said)


def named(name, root=None):
    for w in walk(root):
        if getattr(w, "_wx_name", "") == name:
            return w
    raise AssertionError("the plugin's window has nothing named “%s”" % name)


def fire(w, *binders):
    for b in binders:
        w._wx_fire(b, wx.Event(w, b))


def choose(w, text):
    """Pick an entry of a choice or combo box, as a person would: the value changes and the plugin hears of it."""
    if isinstance(w, wx.ComboBox):
        w.SetValue(text)
        fire(w, wx.EVT_COMBOBOX, wx.EVT_TEXT)
    else:
        w.SetStringSelection(text)
        fire(w, wx.EVT_CHOICE)


def tick(w, on=True):
    w.SetValue(bool(on))
    fire(w, wx.EVT_CHECKBOX)


def press(win, x=None, y=None):
    """Click a control that paints itself (left button down and up at a point inside it, the middle by default)."""
    from wx import _paint
    _paint.fire_mouse(win, "mousedown", x, y)
    _paint.fire_mouse(win, "mouseup", x, y)


def key(win, code):
    """Press a key in a window (a wx.WXK_ code, or a character)."""
    from wx import _paint
    return _paint.key_down(win, code)


def painted(win):
    """The drawing steps a self-painting window last put on its canvas (each a list: name, numbers...)."""
    return list(win.__dict__.get("_wx_last_ops", []))


# ---- a drive that plays the web service a plugin talks to (def net(method, url, headers, body) in the drive)

_opened = []


def _watch_links():
    import kicad_web
    if getattr(kicad_web._open_target, "_kc_watched", False):
        return
    real = kicad_web._open_target

    def watched(target):
        _opened.append(str(target))
        return real(target)

    watched._kc_watched = True
    kicad_web._open_target = watched


_watch_links()


def opened():
    """The web addresses the plugin asked the browser to open, in order."""
    return [t for t in _opened if t.startswith(("http://", "https://"))]


def multipart(headers, body):
    """A multipart/form-data upload, taken apart: ({field: text}, {field: (filename, bytes)})."""
    import email.parser
    import email.policy
    kind = headers.get("content-type", "")
    assert kind.lower().startswith("multipart/form-data"), "the upload is not a form with files: Content-Type %r" % kind
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(b"Content-Type: " + kind.encode("latin-1") + b"\r\n\r\n" + body)
    fields, files = {}, {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        data = part.get_payload(decode=True) or b""
        if filename is not None:
            files[name] = (filename, data)
        else:
            fields[name] = data.decode("utf-8", "replace")
    return fields, files


def archive(data):
    """The files in a zip archive: {name: bytes}."""
    import io
    import zipfile
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {n: z.read(n) for n in z.namelist() if not n.endswith("/")}
