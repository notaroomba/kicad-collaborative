"""ngspice for plugins: the `ngspice` program and the libngspice library, both answered by the real simulator.

The simulator is ngspice itself, compiled to WebAssembly (npm eecircuit-engine, loaded on first use from the server's
own files).  It runs as the interactive program does: it reads commands and prints.  Everything here is built on that:

  * `engine()` is one running ngspice: `command()` gives a command and returns what ngspice printed, with the files the
    command reads (a netlist and what it includes) carried in and the files it writes (wrdata, write) carried out;
  * `ngspice(argv)` is the program in batch mode (`ngspice -b netlist [-r rawfile] [-o log]`), as subprocess runs it;
  * `Library` is what `ctypes.CDLL("libngspice…")` returns: ngSpice_Init, ngSpice_Command, ngSpice_Circ, the plot and
    vector calls, with the caller's own callbacks and structures.

Nothing is computed here: a value a plugin reads is a value ngspice wrote.
"""
import base64
import json
import logging
import os
import re
import struct

log = logging.getLogger("kicad_web")

NGSPICE = "/usr/bin/ngspice"
LIBRARY = "libngspice.so.0"
_PROMPT = re.compile(r"ngspice \d+ -> ")
_MARK = "@@kicad-web-end-of-command-"
_WORK = "/kc"                 # the simulator's own folder for files handed back to the plugin
_TYPES = {"notype": 0, "time": 1, "frequency": 2, "voltage": 3, "current": 4, "output_n_dens": 5, "output_noise": 6,
          "input_n_dens": 7, "input_noise": 8, "pole": 9, "zero": 10, "s-param": 11, "temp-sweep": 12, "res-sweep": 13,
          "impedance": 14, "admittance": 15, "power": 16, "phase": 17, "decibel": 18, "capacitance": 19, "charge": 20}


class Unavailable(OSError):
    """ngspice cannot be started where this interpreter runs."""


# ----------------------------------------------------------------------------- one running ngspice

class _Page:
    """ngspice in the page this interpreter runs in (web/plugins/spice.ts): Python waits on it."""
    def __init__(self, js):
        from pyodide.ffi import run_sync
        self._wait = run_sync
        api = getattr(js, "__kcSpice", None)
        if api is None:
            src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kicad_spice.js")
            el = js.document.createElement("script")
            with open(src, encoding="utf-8") as fh:
                el.textContent = fh.read()
            js.document.head.appendChild(el)
            api = getattr(js, "__kcSpice")              # not js.__kcSpice: a class body mangles the name
        try:
            self._s = run_sync(api.open(str(getattr(js, "__kcPyBase")) + "ngspice.mjs"))
        except Exception as e:
            raise Unavailable(f"ngspice could not be started: {str(e).splitlines()[-1] if str(e) else type(e).__name__}") from e
        self.version = str(self._s.version)

    def exec(self, commands):
        from pyodide.ffi import to_js
        r = self._wait(self._s.exec(to_js(list(commands))))
        return str(r.out), [str(x) for x in r.err.to_py()]

    def write(self, path, data):
        from pyodide.ffi import to_js
        self._s.write(path, to_js(bytes(data)))

    def read(self, path):
        d = self._s.read(path)
        return None if d is None else bytes(d.to_py())

    def list(self, folder):
        return [str(x) for x in self._s.list(folder).to_py()]

    def remove(self, path):
        self._s.remove(path)


class _Replayed:
    """ngspice for an interpreter that cannot wait (the test harness): each request starts the simulator anew and
    replays the session so far (scripts/plugin-spice.mjs).  The same simulator and the same session code; slower."""
    def __init__(self, sync):
        self._sync, self._ops = sync, []
        self.version = self._do(["list", "/"])[0]

    def _do(self, op=None):
        ops = self._ops + ([op] if op else [])
        try:
            r = json.loads(str(self._sync(json.dumps({"ops": ops}))))
        except Exception as e:
            raise Unavailable(f"ngspice could not be started: {str(e).splitlines()[-1] if str(e) else type(e).__name__}") from e
        return r["version"], r["result"]

    def exec(self, commands):
        commands = list(commands)
        self._ops.append(["exec", commands])
        r = self._do()[1]
        # after "destroy all" and "remcirc" ngspice is as it started, bar its settings and files: the replay can forget the rest
        flat = [c.strip().lower() for o in self._ops if o[0] == "exec" for c in o[1] if not c.startswith("echo " + _MARK)]
        if flat and flat[-1] == "remcirc" and "destroy all" in flat:
            last_load = max((i for i, c in enumerate(flat) if c.startswith("source ")), default=-1)
            if "destroy all" in flat[last_load + 1:]:
                self._ops = [o for o in self._ops if o[0] in ("write", "remove") or all(c.strip().lower().startswith(("set ", "unset ", "echo " + _MARK)) for c in o[1])]
        return r["out"], r["err"]

    def write(self, path, data):
        self._ops.append(["write", path, base64.b64encode(bytes(data)).decode("ascii")])

    def read(self, path):
        r = self._do(["read", path])[1]
        return None if r is None else base64.b64decode(r)

    def list(self, folder):
        return list(self._do(["list", folder])[1] or [])

    def remove(self, path):
        self._ops.append(["remove", path])


def _backend():
    try:
        import js
    except ImportError:
        raise Unavailable("ngspice runs in the web editor's page; there is none here") from None
    sync = getattr(js, "__kcSpiceSync", None)
    if sync is not None:
        return _Replayed(sync)
    if hasattr(js, "document") and getattr(js, "__kcPyBase", None) is not None:
        return _Page(js)
    raise Unavailable("ngspice runs in the web editor's page; there is none here")


class RawPlot:
    """One plot of an ngspice raw file: the header and each variable's values."""
    def __init__(self, title="", name="", complex_=False, variables=(), values=()):
        self.title, self.name, self.complex = title, name, complex_
        self.variables = list(variables)        # [(name, type word)]
        self.values = list(values)              # one list per variable: floats, or complex numbers

    def get(self, name):
        want = name.lower()
        for (n, _t), v in zip(self.variables, self.values):
            if n.lower() == want:
                return v
        return None


def parse_raw(data):
    """The plots of a binary raw file, as ngspice's `write` makes it."""
    plots, pos = [], 0
    while pos < len(data):
        mark = data.find(b"Binary:\n", pos)
        if mark < 0:
            break
        head = data[pos:mark].decode("latin-1")
        pos = mark + len(b"Binary:\n")
        field = lambda key: (re.search(r"^" + key + r":[ \t]*(.*)$", head, re.M) or [None, ""])[1].strip()       # noqa: E731
        nvar, npts = int(field("No. Variables") or 0), int(field("No. Points") or 0)
        cplx = "complex" in field("Flags").lower()
        names = []
        for line in head.split("Variables:", 1)[-1].splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[0].isdigit():
                names.append((parts[1], parts[2]))
        names = names[:nvar]
        per = 16 if cplx else 8
        need = nvar * npts * per
        flat = struct.unpack("<%dd" % (nvar * npts * (2 if cplx else 1)), data[pos:pos + need]) if need and pos + need <= len(data) else ()
        pos += need
        cols = [[] for _ in range(nvar)]
        if flat:
            for p in range(npts):
                for v in range(nvar):
                    k = p * nvar + v
                    cols[v].append(complex(flat[2 * k], flat[2 * k + 1]) if cplx else flat[k])
        plots.append(RawPlot(field("Title"), field("Plotname"), cplx, names, cols))
    return plots


class Engine:
    """One ngspice.  `command` is ngSpice_Command: one command line in, what ngspice printed out."""
    def __init__(self):
        self._b = _backend()
        self.version = self._b.version
        self._seen = {}             # files already carried into the simulator: path -> (size, mtime)
        self._b.write(f"{_WORK}/out/.keep", b"")

    # -- files
    def _carry_in(self, path, cwd=None, depth=0):
        """Give the simulator the file a command names, and the files that file includes, at the same paths."""
        p = path if os.path.isabs(path) else os.path.normpath(os.path.join(cwd or os.getcwd(), path))
        try:
            st = os.stat(p)
            with open(p, "rb") as fh:
                data = fh.read()
        except OSError:
            return p
        if self._seen.get(p) != (st.st_size, st.st_mtime):
            self._b.write(p, data)
            self._seen[p] = (st.st_size, st.st_mtime)
        if depth < 8:
            for m in re.finditer(rb"^[ \t]*\.(?:include|inc|lib)[ \t]+(\"[^\"\n]+\"|'[^'\n]+'|\S+)", data, re.M | re.I):
                inner = m.group(1).decode("utf-8", "replace").strip("\"'")
                self._carry_in(inner, os.path.dirname(p), depth + 1)
        return p

    def _carry_out(self, folder):
        """Files a command wrote for the plugin: out of the simulator, into the folder the plugin named."""
        got = []
        for name in self._b.list(_WORK + "/out"):
            if name == ".keep":
                continue
            data = self._b.read(f"{_WORK}/out/{name}")
            self._b.remove(f"{_WORK}/out/{name}")
            if data is None:
                continue
            os.makedirs(folder, exist_ok=True)
            with open(os.path.join(folder, name), "wb") as fh:
                fh.write(data)
            got.append(os.path.join(folder, name))
        return got

    # -- commands
    def raw(self, commands):
        """Run commands as they are; returns [text printed by each], [error lines of all]."""
        # ngspice prints its prompt without ending the line, so a prompt reaches us with whatever is printed next and
        # says nothing about where one command's output ends.  A marker echoed after each command does.
        commands = list(commands)
        marked = []
        for n, c in enumerate(commands):
            marked += [c, f"echo {_MARK}{n}"]
        out, err = self._b.exec(marked)
        out = _PROMPT.sub("", out)
        for line in err:                        # what ngspice wrote as an error is reported as one, not as output too
            out = out.replace(line + "\n\n", "", 1)
        texts, pos = [], 0
        for n in range(len(commands)):
            mark = f"{_MARK}{n}\n"
            at = out.find(mark, pos)
            if at < 0:
                texts.append(out[pos:] if n == 0 or texts else "")
                pos = len(out)
                continue
            texts.append(out[pos:at])
            pos = at + len(mark)
        return texts, err

    def command(self, line, cwd=None):
        """One command, as ngSpice_Command takes it.  Returns (lines printed, lines that are errors)."""
        text = str(line).strip()
        if not text:
            return [], []
        word = text.split()[0].lower()
        if word in ("quit", "exit", "bg_halt", "bg_resume", "bg_ctrl"):
            return [], []                       # the simulator is kept for the next request
        if word == "bg_run":
            text, word = "run" + text[6:], "run"
        folder = None
        if word == "source" and len(text.split(None, 1)) == 2:
            text = "source " + self._carry_in(text.split(None, 1)[1].strip("\"'"), cwd)
        elif word in ("write", "wrdata", "wrs2p", "snsave") and len(text.split()) >= 2:
            bits = text.split(None, 2)
            target = bits[1].strip("\"'")
            target = target if os.path.isabs(target) else os.path.normpath(os.path.join(cwd or os.getcwd(), target))
            folder = os.path.dirname(target)
            text = f"{bits[0]} {_WORK}/out/{os.path.basename(target)}" + (" " + bits[2] if len(bits) > 2 else "")
        texts, err = self.raw([text])
        if folder is not None:
            self._carry_out(folder)
        lines = [ln for ln in texts[0].split("\n")]
        while lines and not lines[-1].strip():
            lines.pop()
        while lines and not lines[0].strip():
            lines.pop(0)
        return lines, err

    def circ(self, lines):
        """ngSpice_Circ: load a netlist given as lines (title first, .end last).  0 when ngspice took it."""
        text = "\n".join(str(x).rstrip("\n") for x in lines) + "\n"
        self._b.write(f"{_WORK}/circ.cir", text.encode("utf-8"))
        texts, err = self.raw([f"source {_WORK}/circ.cir"])
        self.last_output = [ln for ln in texts[0].split("\n") if ln.strip()]
        self.last_errors = err
        bad = any(re.search(r"circuit not parsed|no circuit loaded|there aren't any circuits loaded|could not find|netlist line .* is erroneous", x, re.I) for x in err + self.last_output)
        return 1 if bad else 0

    def plots(self):
        """Names of the plots, newest first, as ngSpice_AllPlots lists them."""
        texts, _ = self.raw(["echo $plots"])
        return list(reversed(texts[0].split()))

    def curplot(self):
        texts, _ = self.raw(["echo $curplot"])
        return (texts[0].split() or ["const"])[0]

    def _written(self, commands):
        self._b.remove(f"{_WORK}/v.raw")
        self.raw(commands)
        data = self._b.read(f"{_WORK}/v.raw")
        self._b.remove(f"{_WORK}/v.raw")
        return parse_raw(data) if data else []

    def plot(self, name=None):
        """Every vector of a plot (the current one by default)."""
        if name is None:
            got = self._written(["set filetype=binary", f"write {_WORK}/v.raw"])
        else:
            cur = self.curplot()
            got = self._written(["set filetype=binary", f"setplot {name}", f"write {_WORK}/v.raw", f"setplot {cur}"])
        if not got:
            return None
        # a raw file names a node's voltage v(node) and a source's current i(source); the library's names are the
        # vectors' own: node and source#branch
        p = got[0]
        p.variables = [(_vector_name(n), t) for n, t in p.variables]
        return p

    def vector(self, name):
        """One vector by the name ngGet_Vec_Info takes ("out", "v1#branch", "op1.out"): (type number, values, is complex),
        or None when ngspice has no such vector."""
        name = str(name).strip()
        got = self._written(["set filetype=binary", f"write {_WORK}/v.raw {name}"])
        if not got or not got[0].variables:
            return None
        p = got[0]
        want = name.split(".", 1)[-1].lower() if "." in name and not name.lower().startswith(("v(", "i(")) else name.lower()
        idx = len(p.variables) - 1
        for i, (n, _t) in enumerate(p.variables):
            if want in (n.lower(), _vector_name(n).lower()) or _vector_name(want) == _vector_name(n).lower():
                idx = i
        return _TYPES.get(p.variables[idx][1].lower(), 0), p.values[idx], p.complex


def _vector_name(name):
    m = re.match(r"^v\((.+)\)$", name, re.I)
    if m:
        return m.group(1)
    m = re.match(r"^i\((.+)\)$", name, re.I)
    return m.group(1) + "#branch" if m else name


_engine = None


def engine():
    """The interpreter's ngspice, started on first use."""
    global _engine
    if _engine is None:
        _engine = Engine()
        log.info("ngspice %s started", _engine.version)
    return _engine


# ----------------------------------------------------------------------------- the program

_USAGE = """Usage: ngspice [OPTION]... [FILE]...
Simulate the electrical circuits in FILE.

  -b, --batch               process FILE in batch mode
  -o, --output=FILE         set the outputfile
  -r, --rawfile=FILE        set the rawfile output
  -h, --help                display this help and exit
  -v, --version             output version information and exit
"""


def _op_table(p):
    """Batch mode prints the operating point as two tables; the values are the plot's own."""
    volts = [(n, v[0]) for (n, t), v in zip(p.variables, p.values) if v and "#branch" not in n and t.lower() == "voltage"]
    amps = [(n, v[0]) for (n, t), v in zip(p.variables, p.values) if v and "#branch" in n]
    out = ["\tNode                                  Voltage", "\t----                                  -------", "\t----\t-------"]
    out += ["\t%-30s%15.6e" % (n, v.real if isinstance(v, complex) else v) for n, v in volts]
    out += ["", "\tSource\tCurrent", "\t------\t-------", ""]
    out += ["\t%-30s%15.6e" % (n, v.real if isinstance(v, complex) else v) for n, v in amps]
    return out + [""]


def ngspice(argv, cwd=None):
    """`ngspice` as a program.  Returns (exit code, stdout, stderr)."""
    args, batch, rawfile, logfile, files = list(argv), False, None, None, []
    i = 0
    while i < len(args):
        a = str(args[i])
        if a in ("-h", "--help"):
            return 0, _USAGE, ""
        if a in ("-v", "--version"):
            e = engine()
            return 0, f"******\n** ngspice-{e.version} : Circuit level simulation program\n** Compiled to WebAssembly for the Junction web editor\n******\n", ""
        if a in ("-b", "--batch"):
            batch = True
        elif a in ("-r", "-o") and i + 1 < len(args):
            i += 1
            rawfile, logfile = (str(args[i]), logfile) if a == "-r" else (rawfile, str(args[i]))
        elif a.startswith("--rawfile="):
            rawfile = a.split("=", 1)[1]
        elif a.startswith("--output="):
            logfile = a.split("=", 1)[1]
        elif a in ("-n", "--no-spiceinit", "-q", "--completion", "-a", "--autorun", "-i", "--interactive", "-p", "--pipe", "-s", "--server"):
            pass
        elif a.startswith("-"):
            return 1, "", f"ngspice: unrecognized option '{a}'\n" + _USAGE
        else:
            files.append(a)
        i += 1
    if not files:
        return 1, "", "ngspice: no input file. The web editor runs ngspice on a netlist file (ngspice -b FILE); it has no terminal for the interactive program.\n"
    here = str(cwd or os.getcwd())
    path = files[0] if os.path.isabs(files[0]) else os.path.normpath(os.path.join(here, files[0]))
    if not os.path.isfile(path):
        return 1, "", f"Error: Could not find include file {files[0]}\n"
    e = engine()
    with open(path, encoding="utf-8", errors="replace") as fh:
        deck = fh.read()
    low = deck.lower()
    out, errs = [], []

    def say(cmd):
        lines, err = e.command(cmd, here)
        out.extend(lines)
        errs.extend(err)
        return lines

    e.command("destroy all")
    e.command("remcirc")
    say(f"source {path}")
    code = 0
    if re.search(r"circuit not parsed|could not find|is erroneous", "\n".join(out + errs), re.I):
        code = 1
    elif not re.search(r"^[ \t]*\.control\b", low, re.M):
        before = set(e.plots())
        say("run")
        new = [p for p in e.plots() if p not in before]
        if not new and re.search(r"^[ \t]*\.(op|tran|ac|dc|noise|tf|sens|pz|disto)\b", low, re.M):
            code = 1
        # batch mode prints what the netlist's .print lines ask for, and the operating point
        for m in re.finditer(r"^[ \t]*\.print[ \t]+(\w+)[ \t]+(.+)$", deck, re.M | re.I):
            say("print " + m.group(2).strip())
        for name in reversed(new):
            if name.lower().startswith("op"):
                p = e.plot(name)
                if p is not None:
                    out.extend(_op_table(p))
    if rawfile and code == 0:
        say("set filetype=binary")
        say(f"write {rawfile if os.path.isabs(rawfile) else os.path.join(here, rawfile)}")
    text = "\n".join(out) + "\n"
    err_text = "".join(x + "\n" for x in errs)
    if logfile:
        with open(logfile if os.path.isabs(logfile) else os.path.join(here, logfile), "w", encoding="utf-8") as fh:
            fh.write(text + err_text)
        text, err_text = "", ""
    return code, text, err_text


# ----------------------------------------------------------------------------- the library

class _Function:
    """A function of the library: called like one, and takes the argtypes and restype a caller declares."""
    def __init__(self, name, impl):
        self.__name__, self._impl, self.argtypes, self.restype = name, impl, None, None

    def __call__(self, *args):
        return self._impl(self, *args)


def _text(value):
    if value is None:
        return ""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf-8", "replace")
    raw = getattr(value, "value", value)
    return raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw)


class Library:
    """What a plugin gets for libngspice: the shared library's calls, answered by the running ngspice."""
    def __init__(self, name=LIBRARY):
        self._name, self._handle = name, 1
        self._cb = {}
        self._keep = []
        for fn in ("ngSpice_Init", "ngSpice_Init_Sync", "ngSpice_Command", "ngSpice_Circ", "ngSpice_CurPlot", "ngSpice_AllPlots",
                   "ngSpice_AllVecs", "ngGet_Vec_Info", "ngSpice_running", "ngSpice_SetBkpt", "ngSpice_nospinit", "ngSpice_nospiceinit"):
            setattr(self, fn, _Function(fn, getattr(self, "_" + fn)))

    def __getattr__(self, name):
        raise AttributeError(f"{self._name}: undefined symbol: {name}")

    __getitem__ = lambda self, name: getattr(self, name)       # noqa: E731

    def _hold(self, obj):
        self._keep.append(obj)
        del self._keep[:-64]
        return obj

    def _say(self, lines, errors=()):
        send = self._cb.get("char")
        if send is None:
            return
        for kind, items in (("stdout", lines), ("stderr", errors)):
            for ln in items:
                try:
                    send(f"{kind} {ln}".encode("utf-8", "replace"), 0, None)
                except Exception:
                    log.debug("ngspice: the plugin's output callback failed", exc_info=True)

    def _ngSpice_Init(self, fn, printfcn=None, statfcn=None, exitfcn=None, datafcn=None, initdata=None, bgrunning=None, userdata=None):
        engine()                                # raises Unavailable (an OSError) where ngspice cannot start
        self._cb = {k: v for k, v in (("char", printfcn), ("stat", statfcn), ("exit", exitfcn), ("bg", bgrunning)) if v is not None}
        return 0

    def _ngSpice_Init_Sync(self, fn, *a):
        return 0

    def _ngSpice_nospinit(self, fn, *a):
        return 0

    _ngSpice_nospiceinit = _ngSpice_nospinit

    def _ngSpice_SetBkpt(self, fn, *a):
        return 1

    def _ngSpice_running(self, fn, *a):
        return False

    def _ngSpice_Command(self, fn, command=None):
        text = _text(command).strip()
        if not text:
            return 0
        background = text.split()[0].lower() == "bg_run"
        bg = self._cb.get("bg")
        if background and bg is not None:
            bg(False, 0, None)
        lines, errs = engine().command(text)
        self._say(lines, errs)
        if background and bg is not None:
            bg(True, 0, None)                   # the run is over when the command returns: nothing runs beside Python here
        return 1 if any(re.search(r"^Error", x) for x in errs) and text.split()[0].lower() in ("source", "run", "bg_run") and not lines else 0

    def _ngSpice_Circ(self, fn, array=None):
        lines = []
        for item in array or ():
            if item is None:
                break
            lines.append(_text(item))
        e = engine()
        rc = e.circ(lines)
        self._say(e.last_output, e.last_errors)
        return rc

    def _ngSpice_CurPlot(self, fn, *a):
        return engine().curplot().encode("ascii", "replace")

    def _names(self, names):
        import ctypes
        arr = (ctypes.c_char_p * (len(names) + 1))()
        for i, n in enumerate(names):
            arr[i] = n.encode("ascii", "replace")
        arr[len(names)] = None
        return self._hold(arr)

    def _ngSpice_AllPlots(self, fn, *a):
        return self._names(engine().plots())

    def _ngSpice_AllVecs(self, fn, plot=None):
        p = engine().plot(_text(plot) or None)
        return self._names([n for n, _t in p.variables] if p else [])

    def _ngGet_Vec_Info(self, fn, name=None):
        import ctypes
        got = engine().vector(_text(name))
        if got is None:
            return None
        kind, values, cplx = got
        n = len(values)
        rtype = getattr(fn.restype, "_type_", None)
        if rtype is None or not hasattr(rtype, "_fields_"):
            class vector_info(ctypes.Structure):
                _fields_ = [("v_name", ctypes.c_char_p), ("v_type", ctypes.c_int), ("v_flags", ctypes.c_short), ("v_realdata", ctypes.POINTER(ctypes.c_double)),
                            ("v_compdata", ctypes.POINTER(ctypes.c_double)), ("v_length", ctypes.c_int)]
            rtype = vector_info
        info = rtype()
        real = (ctypes.c_double * max(n, 1))(*[(v.real if cplx else v) for v in values])
        imag = (ctypes.c_double * max(n, 1))(*[(v.imag if cplx else 0.0) for v in values])
        pairs = (ctypes.c_double * max(2 * n, 2))(*[x for v in values for x in ((v.real, v.imag) if cplx else (v, 0.0))])
        short = _text(name).split(".", 1)[-1].encode("ascii", "replace")
        for field in rtype._fields_:
            fname, ftype = field[0], field[1]
            if fname in ("v_name", "name"):
                setattr(info, fname, short)
            elif fname == "v_type":
                info.v_type = kind
            elif fname == "v_flags":
                info.v_flags = 2 if cplx else 1
            elif fname == "v_length":
                info.v_length = n
            elif fname in ("v_realdata", "pdvec"):
                if not cplx or fname == "pdvec":
                    setattr(info, fname, ctypes.cast(real, ftype))
            elif fname == "v_compdata":
                if cplx:
                    setattr(info, fname, ctypes.cast(pairs, ftype))
            elif fname == "pdvecimg":
                if cplx:
                    setattr(info, fname, ctypes.cast(imag, ftype))
            elif fname == "is_complex":
                setattr(info, fname, bool(cplx))
            elif fname == "is_scale":
                setattr(info, fname, False)
        self._hold((info, real, imag, pairs))
        return self._hold(ctypes.pointer(info))


def is_library(name):
    """Whether a library name a plugin loads is ngspice's."""
    base = os.path.basename(str(name or "")).lower()
    return bool(re.match(r"^(lib)?ngspice([-.]\d+)*\.(so|dylib|dll)(\.\d+)*$", base))


def install():
    """Let plugins find ngspice the way they look for it: as a program on the path and as a library ctypes loads."""
    import ctypes
    import ctypes.util
    if getattr(ctypes, "_kc_spice", False):
        return
    ctypes._kc_spice = True
    real_cdll, real_find = ctypes.CDLL, ctypes.util.find_library

    class CDLL(real_cdll):
        """ctypes.CDLL: ngspice's library is the running simulator; any other library is loaded as before."""
        def __new__(cls, name=None, *a, **k):
            if is_library(name):
                return Library(str(name))
            return real_cdll.__new__(cls)

    CDLL.__name__ = CDLL.__qualname__ = "CDLL"

    def find_library(name):
        return LIBRARY if str(name).lower() in ("ngspice", "libngspice") else real_find(name)

    ctypes.CDLL = CDLL
    ctypes.util.find_library = find_library
    loader = getattr(ctypes, "cdll", None)
    if loader is not None:
        real_load = loader.LoadLibrary

        def load(name, *a, **k):
            return Library(str(name)) if is_library(name) else real_load(name, *a, **k)
        loader.LoadLibrary = load
