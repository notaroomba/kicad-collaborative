"""Desktop programs that plugins start, answered by the web editor.

A plugin on the desktop can start other programs: `kicad-cli` to check or export the design, `git` to keep it under
version control.  There are no other programs in a browser tab, so the two that have an equivalent in the editor are
answered here, in this interpreter, from the editor itself:

  kicad-cli   version · pcb drc · pcb export gerbers / gerber / drill / pos / svg · sch export netlist / bom
              The Design Rules Checker and the fabrication writers of the editor do the work, on the design as it is
              open (not on a file on disk), and the files land where the plugin asked.
              pcb render · pcb export glb
              The editor's 3D viewer draws the board at the pose, size and lights asked for (KiCad's command line
              ray-traces; this is the viewer's own picture) and writes its model as binary glTF.
  git         version · rev-parse · status · add · commit · log · gui / citool
              The project's version history stands in for the repository: a commit is a saved version, the commit
              window is the Save Version dialog.
  ffmpeg      -version · PNG or JPEG frames (-i frame%04d.png) to .gif, .mp4, a palette (.png) or one picture
              The browser decodes and composes the frames; the GIF writer and the MP4 writer are the editor's
              (web/plugins/media.ts), the H.264 stream is the browser's own video encoder.

Everything else a real kicad-cli or git can do is refused with its own error text and a non-zero exit code, as the
program itself would for a command it does not know.
"""

import datetime
import glob as _glob
import hashlib
import io
import json
import logging
import os

import pcbnew

log = logging.getLogger("kicad_web")

KICAD_CLI = "/usr/bin/kicad-cli"
GIT = "/usr/bin/git"
FFMPEG = "/usr/bin/ffmpeg"
NGSPICE = "/usr/bin/ngspice"
PROGRAMS = {"kicad-cli": KICAD_CLI, "kicad-cli.exe": KICAD_CLI, "git": GIT, "git.exe": GIT, "ffmpeg": FFMPEG, "ffmpeg.exe": FFMPEG,
            "ngspice": NGSPICE, "ngspice.exe": NGSPICE, "ngspice_con.exe": NGSPICE}


class Result:
    def __init__(self, code=0, out="", err=""):
        self.code, self.out, self.err = code, out, err


def _web():
    import kicad_web
    return kicad_web


def _abs(path, cwd=None):
    p = str(path)
    return p if os.path.isabs(p) else os.path.normpath(os.path.join(str(cwd or os.getcwd()), p))


def _write(path, data):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data if isinstance(data, bytes) else str(data).encode("utf-8"))


class _Args:
    """kicad-cli's own option style: --name value, --name=value, -o value, switches, then the input file."""

    def __init__(self, argv, values, switches, short=None):
        self.opt, self.flags, self.rest, self.unknown = {}, set(), [], []
        short = dict({"-o": "--output", "-l": "--layers", "-t": "--theme", "-D": "--define-var", "-m": "--mirror", "-n": "--negative"}, **(short or {}))
        i = 0
        while i < len(argv):
            a = argv[i]
            i += 1
            if a == "--":
                self.rest += argv[i:]
                break
            name, eq, val = a.partition("=") if a.startswith("--") else (a, "", "")
            name = short.get(name, name)
            if name in values:
                if eq:
                    self.opt[name] = val
                elif i < len(argv):
                    self.opt[name] = argv[i]
                    i += 1
                else:
                    self.unknown.append(a)
            elif name in switches:
                self.flags.add(name)
            elif a.startswith("-") and len(a) > 1:
                self.unknown.append(a)
            else:
                self.rest.append(a)

    def get(self, name, default=""):
        return self.opt.get(name, default)

    def has(self, name):
        return name in self.flags


def _usage(command, values, switches, positional):
    lines = [f"Usage: {command} [--help] " + " ".join(f"[{v} VAR]" for v in sorted(values)) + " " + " ".join(f"[{s}]" for s in sorted(switches)) + f" {positional}", "",
             "Positional arguments:", f"  {positional}  Input file", "", "Optional arguments:", "  -h, --help  Shows help message and exits"]
    lines += [f"  {v} VAR" for v in sorted(values)] + [f"  {s}" for s in sorted(switches)]
    return "\n".join(lines) + "\n"


def _version():
    try:
        return str(pcbnew.GetBuildVersion())
    except Exception:
        return "10.0.0"


def _layers(text):
    out = []
    for name in str(text or "").split(","):
        name = name.strip()
        if not name:
            continue
        try:
            canon = pcbnew._layer_name(pcbnew._layer_id(name)) if hasattr(pcbnew, "_layer_id") else name
        except Exception:
            canon = name
        out.append(canon or name)
    return out


def _input(args, cwd, kinds, what):
    """The file the command was pointed at.  The editor works on the open design, so the file only has to exist."""
    if not args.rest:
        return None, Result(1, "", f"{what} file is required\n")
    path = _abs(args.rest[0], cwd)
    if not os.path.isfile(path) or not path.endswith(kinds):
        return None, Result(3, "", f"Failed to load {what.lower()}\n")
    return path, None


# ----------------------------------------------------------------------------- kicad-cli pcb

_DRC_VALUES = {"--output", "--format", "--units", "--define-var"}
_DRC_SWITCHES = {"--all-track-errors", "--schematic-parity", "--severity-all", "--severity-error", "--severity-warning", "--severity-exclusions", "--exit-code-violations",
                 "--refill-zones", "--save-board"}


def _pcb_drc(argv, cwd):
    a = _Args(argv, _DRC_VALUES, _DRC_SWITCHES)
    if a.unknown:
        return Result(1, "", f"Unknown argument: {a.unknown[0]}\n" + _usage("kicad-cli pcb drc", _DRC_VALUES, _DRC_SWITCHES, "INPUT_FILE"))
    board, bad = _input(a, cwd, (".kicad_pcb",), "Board")
    if bad:
        return bad
    web = _web()
    web.flush()
    parity = a.has("--schematic-parity")
    # The open board is checked as the editor holds it; any other board file (a copy or a candidate a plugin wrote) is
    # checked from its own text, so the answer is about the file that was named.
    host = pcbnew._Host.board
    own = host is not None and os.path.abspath(board) == os.path.abspath(str(getattr(host, "_filename", "") or ""))
    refilled = None
    if a.has("--refill-zones"):
        try:
            import shapely  # noqa: F401
            target = host if own else pcbnew.BOARD(open(board, encoding="utf-8").read(), board)
            pcbnew.ZONE_FILLER(target).Fill(target.Zones())
            if own:
                web.flush()
                refilled = "open"
            else:
                refilled = target._text()
                if a.has("--save-board"):
                    _write(board, refilled)
        except ImportError:
            refilled = None
    req = {"parity": parity}
    if not own:
        req["text"] = refilled if isinstance(refilled, str) else open(board, encoding="utf-8").read()
    res = web._call("fab.drc", req)
    if res is None:
        return Result(3, "", "Failed to load board\n")
    want = {s for s, flag in (("error", "--severity-error"), ("warning", "--severity-warning")) if a.has(flag)}
    markers = [m for m in res.get("markers") or [] if not want or a.has("--severity-all") or m.get("severity") in want]
    groups = {"violation": [], "unconnected": [], "parity": []}
    for m in markers:
        groups.setdefault(m.get("group") or "violation", []).append(m)
    scale, unit = {"in": (1 / 25.4, "in"), "mils": (1000 / 25.4, "mils")}.get(a.get("--units", "mm"), (1.0, "mm"))

    def entry(m):
        pos = {"x": round(m.get("x", 0) * scale, 4), "y": round(m.get("y", 0) * scale, 4)}
        return {"description": m.get("text") or "", "items": [{"description": i.get("description") or "", "pos": pos, "uuid": i.get("id") or ""} for i in m.get("items") or []],
                "pos": pos, "severity": m.get("severity") or "error", "type": m.get("code") or ""}

    fmt = a.get("--format", "report")
    out = a.get("--output") or os.path.splitext(board)[0] + ("-drc.json" if fmt == "json" else "-drc.rpt")
    out = _abs(out, cwd)
    now = datetime.datetime.now().astimezone()
    if fmt == "json":
        body = json.dumps({"$schema": "https://schemas.kicad.org/drc.v1.json", "coordinate_units": unit, "date": now.isoformat(timespec="seconds"), "kicad_version": _version(),
                           "schematic_parity": [entry(m) for m in groups["parity"]], "source": os.path.basename(board), "unconnected_items": [entry(m) for m in groups["unconnected"]],
                           "violations": [entry(m) for m in groups["violation"]]}, indent=2) + "\n"
    else:
        lines = [f"** Drc report for {os.path.basename(board)} **", f"** Created on {now.strftime('%Y-%m-%dT%H:%M:%S%z')} **", ""]
        for title, key in (("DRC violations", "violation"), ("unconnected pads", "unconnected"), ("Footprint errors", "parity")):
            lines.append(f"** Found {len(groups[key])} {title} **")
            for m in groups[key]:
                lines.append(f"[{m.get('code')}]: {m.get('text')}")
                lines.append(f"    @({m.get('x', 0) * scale:.4f} {unit}, {m.get('y', 0) * scale:.4f} {unit}): {m.get('severity')}")
                lines += ["    " + (i.get("description") or "") for i in m.get("items") or []]
            lines.append("")
        body = "\n".join(lines + ["** End of Report **", ""])
    _write(out, body)
    say = ["Loading board", "Running DRC..."]
    err = []
    if a.has("--refill-zones") and refilled is None:
        err.append("Zones were not refilled: the web editor checks the fills the board holds (Edit > Fill All Zones refills them).")
    if a.has("--save-board") and own:
        err.append("The board was not written: the web editor saves every change as it is made.")
    say.append(f"Found {len(groups['violation'])} violations")
    say.append(f"Found {len(groups['unconnected'])} unconnected items")
    if parity:
        if res.get("parityError"):
            err.append("Schematic parity tests could not run: " + str(res["parityError"]))
        else:
            say.append(f"Found {len(groups['parity'])} schematic parity issues")
    say.append(f"Saved DRC Report to {out}")
    if res.get("note"):
        log.warning("kicad-cli pcb drc: %s", res["note"])
    code = 5 if a.has("--exit-code-violations") and markers else 0
    return Result(code, "\n".join(say) + "\n", "\n".join(err) + ("\n" if err else ""))


_GBR_VALUES = {"--output", "--layers", "--drawing-sheet", "--define-var", "--precision", "--common-layers", "--theme", "--variant"}
_GBR_SWITCHES = {"--exclude-refdes", "--exclude-value", "--include-border-title", "--sketch-pads-on-fab-layers", "--hide-DNP-footprints-on-fab-layers",
                 "--sketch-DNP-footprints-on-fab-layers", "--crossout-DNP-footprints-on-fab-layers", "--no-x2", "--no-netlist", "--subtract-soldermask", "--disable-aperture-macros",
                 "--use-drill-file-origin", "--no-protel-ext", "--board-plot-params", "--check-zones", "--erd", "--exclude-refdes"}


def _plot_params():
    """The plot settings the board file holds (File > Plot's last use), for --board-plot-params."""
    b = pcbnew._Host.board
    try:
        return b.GetPlotOptions() if b is not None else None
    except Exception:
        return None


def _pcb_gerbers(argv, cwd, one=False):
    a = _Args(argv, _GBR_VALUES, _GBR_SWITCHES)
    name = "kicad-cli pcb export " + ("gerber" if one else "gerbers")
    if a.unknown:
        return Result(1, "", f"Unknown argument: {a.unknown[0]}\n" + _usage(name, _GBR_VALUES, _GBR_SWITCHES, "INPUT_FILE"))
    board, bad = _input(a, cwd, (".kicad_pcb",), "Board")
    if bad:
        return bad
    web = _web()
    web.flush()
    layers = _layers(a.get("--layers"))
    opts = {"useProtelExtensions": not a.has("--no-protel-ext"), "useGerberX2": not a.has("--no-x2"), "useAuxOrigin": a.has("--use-drill-file-origin"),
            "precision": 5 if a.get("--precision") == "5" else 6, "plotReference": not a.has("--exclude-refdes"), "plotValue": not a.has("--exclude-value"),
            "subtractMaskFromSilk": a.has("--subtract-soldermask"), "commonLayers": _layers(a.get("--common-layers")),
            "sketchDnpOnFab": a.has("--sketch-DNP-footprints-on-fab-layers") or None, "hideDnpOnFab": a.has("--hide-DNP-footprints-on-fab-layers") or None,
            "crossoutDnpOnFab": a.has("--crossout-DNP-footprints-on-fab-layers") or None}
    if a.has("--board-plot-params"):
        po = _plot_params()
        if po is not None:
            get = lambda n, d: (getattr(po, "Get" + n)() if hasattr(po, "Get" + n) else d)      # noqa: E731
            opts.update({"useProtelExtensions": bool(get("UseGerberProtelExtensions", False)), "useGerberX2": bool(get("UseGerberX2format", True)),
                         "useAuxOrigin": bool(get("UseAuxOrigin", False)), "precision": 5 if get("GerberPrecision", 6) == 5 else 6,
                         "plotReference": bool(get("PlotReference", True)), "plotValue": bool(get("PlotValue", True)), "subtractMaskFromSilk": bool(get("SubtractMaskFromSilk", False))})
            if not layers:
                try:
                    layers = [pcbnew._layer_name(l) for l in po.GetLayerSelection().Seq()]
                except Exception:
                    layers = []
    if not layers:
        if one:
            return Result(1, "", "At least one layer must be specified\n")
        have = (web._call("fab.layers") or {}).get("layers") or []
        layers = [l for l in have if l.endswith(".Cu") or l.split(".")[-1] in ("Paste", "SilkS", "Silkscreen", "Mask") or l == "Edge.Cuts"]
    opts["layers"] = layers
    res = web._call("fab.gerbers", opts) or {}
    files = res.get("files") or []
    out = _abs(a.get("--output") or (os.path.splitext(board)[0] + ".gbr" if one else os.path.dirname(board)), cwd)
    said = []
    for w in res.get("warnings") or []:
        log.warning("plot: %s", w)
    for l in res.get("missing") or []:
        said.append(f"Layer {l} is not in this board; skipped")
    if one:
        if not files:
            return Result(4, "", "No layers to plot\n")
        _write(out, files[0]["text"])
        said.append(f"Plotted to '{out}'.")
    else:
        for f in files:
            path = os.path.join(out, f["name"])
            _write(path, f["text"])
            said.append(f"Plotted to '{path}'.")
        os.makedirs(out, exist_ok=True)
    return Result(0, "\n".join(said) + "\n", "")


_DRL_VALUES = {"--output", "--format", "--drill-origin", "--excellon-zeros-format", "--excellon-oval-format", "--excellon-units", "--map-format", "--gerber-precision", "--define-var"}
_DRL_SWITCHES = {"--excellon-mirror-y", "--excellon-min-header", "--excellon-separate-th", "--generate-map", "--generate-tenting", "--generate-report"}


def _pcb_drill(argv, cwd):
    a = _Args(argv, _DRL_VALUES, _DRL_SWITCHES, {"-u": "--excellon-units"})
    if a.unknown:
        return Result(1, "", f"Unknown argument: {a.unknown[0]}\n" + _usage("kicad-cli pcb export drill", _DRL_VALUES, _DRL_SWITCHES, "INPUT_FILE"))
    board, bad = _input(a, cwd, (".kicad_pcb",), "Board")
    if bad:
        return bad
    if a.get("--format", "excellon") != "excellon":
        return Result(2, "", "Drill files in Gerber X2 format are not written by the web editor; Excellon drill files are (--format excellon).\n")
    web = _web()
    web.flush()
    zeros = {"decimal": "decimal", "suppressleading": "suppress_leading", "suppresstrailing": "suppress_trailing", "keep": "keep"}.get(a.get("--excellon-zeros-format", "decimal"), "decimal")
    res = web._call("fab.drill", {"metric": a.get("--excellon-units", "mm") != "in", "zeros": zeros, "merge": not a.has("--excellon-separate-th"), "minimalHeader": a.has("--excellon-min-header"),
                                  "mirrorY": a.has("--excellon-mirror-y"), "ovalMode": "g85" if a.get("--excellon-oval-format", "route") == "alternate" else "route",
                                  "useAuxOrigin": a.get("--drill-origin", "absolute") == "plot"}) or {}
    out = _abs(a.get("--output") or os.path.dirname(board), cwd)
    os.makedirs(out, exist_ok=True)
    said, err = [], []
    for f in res.get("files") or []:
        path = os.path.join(out, f["name"])
        _write(path, f["text"])
        said.append(f"Created file {path}")
    if a.has("--generate-map"):
        err.append("Drill map files are not written by the web editor; the drill files are.")
    return Result(0, "\n".join(said) + "\n", "\n".join(err) + ("\n" if err else ""))


_POS_VALUES = {"--output", "--side", "--format", "--units", "--define-var", "--variant"}
_POS_SWITCHES = {"--bottom-negate-x", "--use-drill-file-origin", "--smd-only", "--exclude-fp-th", "--exclude-dnp", "--gerber-board-edge"}


def _pcb_pos(argv, cwd):
    a = _Args(argv, _POS_VALUES, _POS_SWITCHES)
    if a.unknown:
        return Result(1, "", f"Unknown argument: {a.unknown[0]}\n" + _usage("kicad-cli pcb export pos", _POS_VALUES, _POS_SWITCHES, "INPUT_FILE"))
    board, bad = _input(a, cwd, (".kicad_pcb",), "Board")
    if bad:
        return bad
    fmt = a.get("--format", "ascii")
    if fmt == "gerber":
        return Result(2, "", "Placement files in Gerber X3 format are not written by the web editor; ascii and csv are.\n")
    web = _web()
    web.flush()
    side = a.get("--side", "both")
    text = web._fab_positions(None, {"top": side in ("front", "both"), "bottom": side in ("back", "both"), "smdOnly": a.has("--smd-only"), "excludeTH": a.has("--exclude-fp-th"),
                                     "excludeDNP": a.has("--exclude-dnp"), "useAuxOrigin": a.has("--use-drill-file-origin"), "negateBottomX": a.has("--bottom-negate-x"),
                                     "metric": a.get("--units", "in") == "mm", "csv": fmt == "csv"})
    out = _abs(a.get("--output") or os.path.splitext(board)[0] + (".csv" if fmt == "csv" else ".pos"), cwd)
    _write(out, text)
    return Result(0, f"Wrote front and back position data to '{out}'\n", "")


_SVG_VALUES = {"--output", "--layers", "--drawing-sheet", "--define-var", "--theme", "--page-size-mode", "--drill-shape-opt", "--common-layers", "--scale", "--variant"}
_SVG_SWITCHES = {"--mirror", "--negative", "--black-and-white", "--sketch-pads-on-fab-layers", "--hide-DNP-footprints-on-fab-layers", "--sketch-DNP-footprints-on-fab-layers",
                 "--crossout-DNP-footprints-on-fab-layers", "--exclude-drawing-sheet", "--mode-single", "--mode-multi", "--fit-page-to-board", "--exclude-refdes", "--exclude-value",
                 "--plot-invisible-text", "--check-zones", "--include-border-title", "--subtract-soldermask"}


def _pcb_svg(argv, cwd):
    a = _Args(argv, _SVG_VALUES, _SVG_SWITCHES)
    if a.unknown:
        return Result(1, "", f"Unknown argument: {a.unknown[0]}\n" + _usage("kicad-cli pcb export svg", _SVG_VALUES, _SVG_SWITCHES, "INPUT_FILE"))
    board, bad = _input(a, cwd, (".kicad_pcb",), "Board")
    if bad:
        return bad
    layers = _layers(a.get("--layers"))
    if not layers:
        return Result(1, "", "At least one layer must be specified\n")
    multi = a.has("--mode-multi")
    web = _web()
    web.flush()
    res = web._call("fab.svg", {"layers": layers, "commonLayers": _layers(a.get("--common-layers")), "mirror": a.has("--mirror"), "blackAndWhite": a.has("--black-and-white"),
                                "area": "board" if a.get("--page-size-mode", "0") == "2" or a.has("--fit-page-to-board") else "page", "single": not multi,
                                "plotReference": not a.has("--exclude-refdes"), "plotValue": not a.has("--exclude-value")}) or {}
    files = res.get("files") or []
    if not files:
        return Result(4, "", "No layers to plot\n")
    for w in res.get("warnings") or []:
        log.warning("plot: %s", w)
    out = a.get("--output")
    said = []
    if multi:
        out = _abs(out or os.path.dirname(board), cwd)
        for f in files:
            path = os.path.join(out, f["name"])
            _write(path, f["text"])
            said.append(f"Plotted to '{path}'.")
    else:
        out = _abs(out or os.path.splitext(board)[0] + ".svg", cwd)
        if os.path.isdir(out) or str(a.get("--output")).endswith(("/", os.sep)):
            out = os.path.join(out, files[0]["name"])
        _write(out, files[0]["text"])
        said.append(f"Plotted to '{out}'.")
    err = []
    if a.get("--page-size-mode", "0") == "0" and not a.has("--exclude-drawing-sheet"):
        err.append("The drawing sheet (page border and title block) is not plotted by the web editor.")
    return Result(0, "\n".join(said) + "\n", "\n".join(err) + ("\n" if err else ""))


# ----------------------------------------------------------------------------- kicad-cli pcb render / export glb

_RENDER_VALUES = {"--output", "--width", "--height", "--side", "--background", "--quality", "--preset", "--appearance-preset", "--zoom", "--pan", "--pivot", "--rotate",
                  "--light-top", "--light-bottom", "--light-side", "--light-camera", "--light-side-elevation", "--define-var", "--variant"}
_RENDER_SWITCHES = {"--perspective", "--floor", "--use-board-stackup-colors"}
_GLB_VALUES = {"--output", "--define-var", "--min-distance", "--net-filter", "--user-origin", "--component-filter", "--variant"}
_GLB_SWITCHES = {"--force", "--grid-origin", "--drill-origin", "--no-unspecified", "--no-dnp", "--subst-models", "--board-only", "--cut-vias-in-body", "--no-board-body",
                 "--no-components", "--include-tracks", "--include-pads", "--include-zones", "--include-inner-copper", "--include-silkscreen", "--include-soldermask",
                 "--fuse-shapes", "--fill-all-vias", "--no-optimize-step", "--no-extra-pad-thickness"}


def _numbers(text, count, what):
    """'1,2,3' (or one number for all of them) as a list of floats; None when it is not that."""
    try:
        vals = [float(x) for x in str(text).replace("'", "").replace('"', "").split(",") if x.strip() != ""]
    except ValueError:
        return None
    if len(vals) == 1 and what == "light":
        vals = vals * count
    return vals if len(vals) == count else None


def _viewer3d(method, args, board):
    """Ask the editor's 3D viewer for a picture or a model of the board in `board` (a file in this interpreter).  The
    editor keeps the board set up between calls, so the file crosses once however many frames follow."""
    with open(board, "rb") as fh:
        data = fh.read()
    key = hashlib.sha1(data).hexdigest()
    web = _web()
    res = web._call(method, dict(args, key=key))
    if isinstance(res, dict) and res.get("needText"):
        res = web._call(method, dict(args, key=key, text=data.decode("utf-8", "replace")))
    return res


def _pcb_render(argv, cwd):
    a = _Args(argv, _RENDER_VALUES, _RENDER_SWITCHES, {"-w": "--width", "-h": "--height"})
    if a.unknown:
        return Result(1, "", f"Unknown argument: {a.unknown[0]}\n" + _usage("kicad-cli pcb render", _RENDER_VALUES, _RENDER_SWITCHES, "INPUT_FILE"))
    board, bad = _input(a, cwd, (".kicad_pcb",), "Board")
    if bad:
        return bad
    out = a.get("--output")
    if not out:
        return Result(1, "", "Output file is required (--output)\n")
    out = _abs(out, cwd)
    ext = os.path.splitext(out)[1].lower()
    if ext not in (".png", ".jpg", ".jpeg"):
        return Result(1, "", "Invalid image format: the output file must end in .png or .jpg\n")
    side = a.get("--side", "top").lower()
    if side not in ("top", "bottom", "left", "right", "front", "back"):
        return Result(1, "", "Invalid side specified\n")
    background = a.get("--background", "default").lower()
    if background not in ("default", "transparent", "opaque"):
        return Result(1, "", "Invalid background specified\n")
    args = {"side": side, "perspective": a.has("--perspective"), "format": "png" if ext == ".png" else "jpeg",
            "background": ("transparent" if ext == ".png" else "opaque") if background == "default" else background}
    try:
        args["width"], args["height"] = int(a.get("--width", "1600")), int(a.get("--height", "900"))
        args["zoom"] = float(a.get("--zoom", "1"))
    except ValueError:
        return Result(1, "", "Invalid size or zoom\n")
    for name, key in (("--rotate", "rotate"), ("--pan", "pan")):
        if name in a.opt:
            v = _numbers(a.get(name), 3, "vector")
            if v is None:
                return Result(1, "", f"Invalid {key} format: three numbers are needed, as in '-45,0,45'\n")
            args[key] = v
    lights = {}
    for name, key in (("--light-top", "top"), ("--light-bottom", "bottom"), ("--light-side", "side"), ("--light-camera", "camera")):
        if name in a.opt:
            v = _numbers(a.get(name), 3, "light")
            if v is None:
                return Result(1, "", f"Invalid light {key} format: one intensity or 'R,G,B'\n")
            lights[key] = v
    if "--light-side-elevation" in a.opt:
        try:
            lights["sideElevation"] = float(a.get("--light-side-elevation"))
        except ValueError:
            return Result(1, "", "Invalid light side elevation\n")
    if lights:
        args["lights"] = lights
    try:
        res = _viewer3d("fab.render", args, board)
    except Exception as e:      # no WebGL in this browser, or the board could not be read
        return Result(1, "", f"Failed to render the board: {str(e).splitlines()[-1] if str(e) else type(e).__name__}\n")
    if not isinstance(res, dict) or not res.get("base64"):
        return Result(1, "", "Failed to render the board: the editor's 3D viewer gave no picture\n")
    import base64
    _write(out, base64.b64decode(res["base64"]))
    log.info("kicad-cli pcb render: %sx%s drawn by the editor's 3D viewer (not ray-traced)", res.get("width"), res.get("height"))
    return Result(0, f"Successfully created 3D render image '{out}'\n", "")


def _pcb_glb(argv, cwd):
    a = _Args(argv, _GLB_VALUES, _GLB_SWITCHES, {"-f": "--force"})
    if a.unknown:
        return Result(1, "", f"Unknown argument: {a.unknown[0]}\n" + _usage("kicad-cli pcb export glb", _GLB_VALUES, _GLB_SWITCHES, "INPUT_FILE"))
    board, bad = _input(a, cwd, (".kicad_pcb",), "Board")
    if bad:
        return bad
    out = _abs(a.get("--output") or os.path.splitext(board)[0] + ".glb", cwd)
    if os.path.exists(out) and not a.has("--force") and os.path.getsize(out) > 0:
        return Result(2, "", f"File '{out}' already exists. Use --force to overwrite.\n")
    try:
        res = _viewer3d("fab.model", {}, board)
    except Exception as e:
        return Result(1, "", f"Failed to export the model: {str(e).splitlines()[-1] if str(e) else type(e).__name__}\n")
    if not isinstance(res, dict) or not res.get("base64"):
        return Result(1, "", "Failed to export the model: the editor's 3D viewer gave none\n")
    import base64
    _write(out, base64.b64decode(res["base64"]))
    log.info("kicad-cli pcb export glb: the editor's 3D model (board, copper and silkscreen pictures, component bodies), %s bytes", res.get("bytes"))
    return Result(0, f"Info: GLB file '{out}' created.\n", "")


# ----------------------------------------------------------------------------- kicad-cli sch

def _q(v):
    return '"' + str("" if v is None else v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def _netlist_sexpr(n, source):
    out = ['(export (version "E")', f'  (design\n    (source {_q(source)})\n    (date {_q(datetime.datetime.now().astimezone().isoformat(timespec="seconds"))})\n    (tool {_q("Eeschema " + _version())}))',
           "  (components"]
    for c in n.get("components") or []:
        lib, _, part = str(c.get("libId") or "").partition(":")
        path = (c.get("paths") or ["/"])[0]
        sheet, _, stamp = path.rpartition("/")
        fields = c.get("fields") or {}
        row = [f"    (comp (ref {_q(c.get('ref'))})", f"      (value {_q(c.get('value'))})"]
        if c.get("footprint"):
            row.append(f"      (footprint {_q(c['footprint'])})")
        if fields.get("Datasheet"):
            row.append(f"      (datasheet {_q(fields['Datasheet'])})")
        if fields.get("Description"):
            row.append(f"      (description {_q(fields['Description'])})")
        extra = [(k, v) for k, v in fields.items() if k not in ("Datasheet", "Description")]
        row.append("      (fields\n" + "\n".join([f"        (field (name \"Footprint\") {_q(c.get('footprint'))})", f"        (field (name \"Datasheet\") {_q(fields.get('Datasheet', ''))})",
                                                    f"        (field (name \"Description\") {_q(fields.get('Description', ''))})"]
                                                   + [f"        (field (name {_q(k)}) {_q(v)})" for k, v in extra]) + ")")
        row.append(f"      (libsource (lib {_q(lib)}) (part {_q(part)}) (description {_q(fields.get('Description', ''))}))")
        row.append(f"      (property (name \"Sheetname\") (value {_q(c.get('sheetName') or 'Root')}))")
        row.append(f"      (property (name \"Sheetfile\") (value {_q(c.get('sheetFile') or source)}))")
        if c.get("dnp"):
            row.append('      (property (name "dnp"))')
        if c.get("excludeFromBom"):
            row.append('      (property (name "exclude_from_bom"))')
        if c.get("excludeFromBoard"):
            row.append('      (property (name "exclude_from_board"))')
        row.append(f"      (sheetpath (names {_q('/' if not sheet else '/' + (c.get('sheetName') or '') + '/')}) (tstamps {_q((sheet or '') + '/')}))")
        row.append(f"      (tstamps {_q(stamp)}))")
        out.append("\n".join(row))
    out.append("  )")
    pins = {}
    for c in n.get("components") or []:
        for p in c.get("pins") or []:
            pins[(c.get("ref"), str(p.get("num")))] = p
    out.append("  (nets")
    for i, net in enumerate(sorted(n.get("nets") or [], key=lambda x: x.get("name") or "")):
        rows = [f"    (net (code {_q(i + 1)}) (name {_q(net.get('name'))}) (class \"Default\")"]
        for node in net.get("nodes") or []:
            p = pins.get((node.get("ref"), str(node.get("pin")))) or {}
            fn = f" (pinfunction {_q(p['name'])})" if p.get("name") and p.get("name") != "~" else ""
            rows.append(f"      (node (ref {_q(node.get('ref'))}) (pin {_q(node.get('pin'))}){fn} (pintype {_q(p.get('type') or 'passive')}))")
        out.append("\n".join(rows) + ")")
    out.append("  ))")
    return "\n".join(out) + "\n"


def _netlist_xml(n, source):
    """KiCad's XML netlist (--format kicadxml): the same tree as the s-expression netlist, written as elements."""
    from xml.sax.saxutils import escape, quoteattr

    def at(**kw):
        return "".join(f" {k}={quoteattr(str(v if v is not None else ''))}" for k, v in kw.items())

    def el(tag, text):
        return f"<{tag}>{escape(str(text if text is not None else ''))}</{tag}>"

    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<export version="E">', "  <design>", "    " + el("source", source),
           "    " + el("date", datetime.datetime.now().astimezone().isoformat(timespec="seconds")), "    " + el("tool", "Eeschema " + _version()), "  </design>", "  <components>"]
    for c in n.get("components") or []:
        lib, _, part = str(c.get("libId") or "").partition(":")
        path = (c.get("paths") or ["/"])[0]
        sheet, _, stamp = path.rpartition("/")
        fields = c.get("fields") or {}
        out.append(f"    <comp{at(ref=c.get('ref'))}>")
        out.append("      " + el("value", c.get("value")))
        if c.get("footprint"):
            out.append("      " + el("footprint", c["footprint"]))
        if fields.get("Datasheet"):
            out.append("      " + el("datasheet", fields["Datasheet"]))
        if fields.get("Description"):
            out.append("      " + el("description", fields["Description"]))
        out.append("      <fields>")
        for k, v in [("Footprint", c.get("footprint")), ("Datasheet", fields.get("Datasheet", "")), ("Description", fields.get("Description", ""))] + \
                [(k, v) for k, v in fields.items() if k not in ("Datasheet", "Description")]:
            out.append(f"        <field{at(name=k)}>{escape(str(v if v is not None else ''))}</field>")
        out.append("      </fields>")
        out.append(f"      <libsource{at(lib=lib, part=part, description=fields.get('Description', ''))}/>")
        out.append(f"      <property{at(name='Sheetname', value=c.get('sheetName') or 'Root')}/>")
        out.append(f"      <property{at(name='Sheetfile', value=c.get('sheetFile') or source)}/>")
        for flag, name in (("dnp", "dnp"), ("excludeFromBom", "exclude_from_bom"), ("excludeFromBoard", "exclude_from_board")):
            if c.get(flag):
                out.append(f"      <property{at(name=name)}/>")
        out.append(f"      <sheetpath{at(names='/' if not sheet else '/' + (c.get('sheetName') or '') + '/', tstamps=(sheet or '') + '/')}/>")
        out.append("      " + el("tstamps", stamp))
        out.append("    </comp>")
    out.append("  </components>")
    pins = {}
    for c in n.get("components") or []:
        for p in c.get("pins") or []:
            pins[(c.get("ref"), str(p.get("num")))] = p
    out.append("  <nets>")
    for i, net in enumerate(sorted(n.get("nets") or [], key=lambda x: x.get("name") or "")):
        out.append(f"    <net{at(code=i + 1, name=net.get('name'))} class=\"Default\">")
        for node in net.get("nodes") or []:
            p = pins.get((node.get("ref"), str(node.get("pin")))) or {}
            kw = {"ref": node.get("ref"), "pin": node.get("pin")}
            if p.get("name") and p.get("name") != "~":
                kw["pinfunction"] = p["name"]
            kw["pintype"] = p.get("type") or "passive"
            out.append(f"      <node{at(**kw)}/>")
        out.append("    </net>")
    out.append("  </nets>")
    out.append("</export>")
    return "\n".join(out) + "\n"


_NET_VALUES = {"--output", "--format", "--variant", "--define-var"}


def _sch_netlist(argv, cwd):
    a = _Args(argv, _NET_VALUES, set())
    if a.unknown:
        return Result(1, "", f"Unknown argument: {a.unknown[0]}\n" + _usage("kicad-cli sch export netlist", _NET_VALUES, set(), "INPUT_FILE"))
    sch, bad = _input(a, cwd, (".kicad_sch",), "Schematic")
    if bad:
        return bad
    fmt = a.get("--format", "kicadsexpr")
    if fmt not in ("kicadsexpr", "kicadxml"):
        return Result(2, "", f"The web editor writes netlists in KiCad's own formats (--format kicadsexpr or kicadxml), not {fmt}.\n")
    try:
        n = _web()._call("fab.netlist") or {}
    except Exception as e:
        return Result(3, "", f"Failed to load schematic: {e}\n")
    out = _abs(a.get("--output") or os.path.splitext(sch)[0] + ".net", cwd)
    _write(out, (_netlist_xml if fmt == "kicadxml" else _netlist_sexpr)(n, os.path.basename(sch)))
    return Result(0, "", "")


_BOM_VALUES = {"--output", "--preset", "--format-preset", "--fields", "--labels", "--group-by", "--sort-field", "--filter", "--field-delimiter", "--string-delimiter", "--ref-delimiter",
               "--ref-range-delimiter", "--variant", "--define-var"}
_BOM_SWITCHES = {"--sort-asc", "--exclude-dnp", "--include-excluded-from-bom", "--keep-tabs", "--keep-line-breaks"}


def _ref_key(ref):
    import re
    m = re.match(r"^(.*?)(\d+)$", str(ref))
    return (m.group(1), int(m.group(2))) if m else (str(ref), 0)


def _sch_bom(argv, cwd):
    a = _Args(argv, _BOM_VALUES, _BOM_SWITCHES)
    if a.unknown:
        return Result(1, "", f"Unknown argument: {a.unknown[0]}\n" + _usage("kicad-cli sch export bom", _BOM_VALUES, _BOM_SWITCHES, "INPUT_FILE"))
    sch, bad = _input(a, cwd, (".kicad_sch",), "Schematic")
    if bad:
        return bad
    try:
        n = _web()._call("fab.netlist") or {}
    except Exception as e:
        return Result(3, "", f"Failed to load schematic: {e}\n")
    fields = [f for f in a.get("--fields", "Reference,Value,Footprint,${QUANTITY},${DNP}").split(",") if f]
    labels = [l for l in a.get("--labels", "").split(",")] if a.get("--labels") else ["Refs" if f == "Reference" else {"${QUANTITY}": "Qty", "${DNP}": "DNP", "${ITEM_NUMBER}": "#"}.get(f, f) for f in fields]
    labels += fields[len(labels):]
    group_by = [g for g in a.get("--group-by", "").split(",") if g]
    fd, sd = a.get("--field-delimiter", ","), a.get("--string-delimiter", '"')
    rd, rrd = a.get("--ref-delimiter", ","), a.get("--ref-range-delimiter", "-")

    def value(c, f):
        if f == "Reference":
            return c.get("ref") or ""
        if f == "Value":
            return c.get("value") or ""
        if f == "Footprint":
            return c.get("footprint") or ""
        if f == "${DNP}":
            return "DNP" if c.get("dnp") else ""
        if f == "${EXCLUDE_FROM_BOM}":
            return "Excluded from BOM" if c.get("excludeFromBom") else ""
        if f == "${EXCLUDE_FROM_BOARD}":
            return "Excluded from board" if c.get("excludeFromBoard") else ""
        return (c.get("fields") or {}).get(f, "")

    comps = [c for c in n.get("components") or [] if not str(c.get("ref") or "").startswith("#")
             and (a.has("--include-excluded-from-bom") or not c.get("excludeFromBom")) and not (a.has("--exclude-dnp") and c.get("dnp"))]
    comps.sort(key=lambda c: _ref_key(c.get("ref")))
    groups, index = [], {}
    for c in comps:
        key = tuple(value(c, g) for g in group_by) if group_by else (c.get("ref"),)
        if key not in index:
            index[key] = len(groups)
            groups.append([])
        groups[index[key]].append(c)

    def refs(group):
        names = [c.get("ref") or "" for c in group]
        if not rrd or len(names) < 3:
            return rd.join(names)
        out, i = [], 0
        while i < len(names):
            j = i
            while j + 1 < len(names) and _ref_key(names[j + 1])[0] == _ref_key(names[i])[0] and _ref_key(names[j + 1])[1] == _ref_key(names[j])[1] + 1:
                j += 1
            out.append(names[i] + rrd + names[j] if j - i >= 2 else rd.join(names[i:j + 1]))
            i = j + 1
        return rd.join(out)

    def cell(text):
        text = str(text)
        if not a.has("--keep-tabs"):
            text = text.replace("\t", "")
        if not a.has("--keep-line-breaks"):
            text = text.replace("\r", "").replace("\n", "")
        return sd + text.replace(sd, sd + sd) + sd if sd else text

    sort_field = a.get("--sort-field", "Reference")
    if sort_field != "Reference" and sort_field in fields:
        groups.sort(key=lambda g: value(g[0], sort_field))
    if a.get("--sort-field") and not a.has("--sort-asc"):
        groups.reverse()
    rows = [fd.join(cell(l) for l in labels)]
    for i, g in enumerate(groups):
        rows.append(fd.join(cell(refs(g) if f == "Reference" else len(g) if f == "${QUANTITY}" else i + 1 if f == "${ITEM_NUMBER}" else value(g[0], f)) for f in fields))
    out = _abs(a.get("--output") or os.path.splitext(sch)[0] + ".csv", cwd)
    _write(out, "\n".join(rows) + "\n")
    return Result(0, "", "")


_HELP = """Usage: kicad-cli [--version] [--help] {fp,jobset,pcb,sch,sym,version}

Optional arguments:
  -v, --version  prints version information and exits
  -h, --help     shows help message and exits

Subcommands:
  pcb      PCB: drc, export gerbers|gerber|drill|pos|svg
  sch      Schematics: export netlist|bom
  version  Reports the version info in various formats

This is the Junction web editor answering for kicad-cli; other subcommands need the desktop application.
"""

_PCB = {("drc",): (_pcb_drc, _DRC_VALUES, _DRC_SWITCHES), ("export", "gerbers"): (_pcb_gerbers, _GBR_VALUES, _GBR_SWITCHES),
        ("export", "gerber"): (lambda argv, cwd: _pcb_gerbers(argv, cwd, True), _GBR_VALUES, _GBR_SWITCHES), ("export", "drill"): (_pcb_drill, _DRL_VALUES, _DRL_SWITCHES),
        ("export", "pos"): (_pcb_pos, _POS_VALUES, _POS_SWITCHES), ("export", "svg"): (_pcb_svg, _SVG_VALUES, _SVG_SWITCHES),
        ("render",): (_pcb_render, _RENDER_VALUES, _RENDER_SWITCHES), ("export", "glb"): (_pcb_glb, _GLB_VALUES, _GLB_SWITCHES)}
_SCH = {("export", "netlist"): (_sch_netlist, _NET_VALUES, set()), ("export", "bom"): (_sch_bom, _BOM_VALUES, _BOM_SWITCHES)}
_DESKTOP_ONLY = {("pcb", "export", "step"): "exporting a STEP model",
                 ("pcb", "export", "vrml"): "exporting a 3D model", ("pcb", "export", "pdf"): "plotting to PDF (File > Plot does that in the editor)",
                 ("pcb", "export", "dxf"): "plotting to DXF", ("sch", "erc"): "the electrical rules check from the command line (Inspect > Electrical Rules Checker runs it in the editor)",
                 ("sch", "export", "pdf"): "plotting the schematic to PDF (File > Plot does that in the editor)", ("sch", "export", "svg"): "plotting the schematic to SVG"}


def kicad_cli(argv, cwd=None):
    if not argv or argv[0] in ("-h", "--help"):
        return Result(0, _HELP, "")
    if argv[0] in ("-v", "--version"):
        return Result(0, _version() + "\n", "")
    if argv[0] == "version":
        fmt = "plain"
        for i, x in enumerate(argv):
            if x == "--format" and i + 1 < len(argv):
                fmt = argv[i + 1]
            elif x.startswith("--format="):
                fmt = x.split("=", 1)[1]
        if fmt == "about":
            return Result(0, f"Application: kicad-cli (Junction web editor)\n\nVersion: {_version()}\n\nPlatform: web browser\n", "")
        return Result(0, _version() + "\n", "")
    table = _PCB if argv[0] == "pcb" else _SCH if argv[0] == "sch" else None
    if table is not None:
        for key, (fn, values, switches) in table.items():
            if tuple(argv[1:1 + len(key)]) == key:
                rest = argv[1 + len(key):]
                if "--help" in rest or ("-h" in rest and key != ("render",)):       # render's -h is the picture's height
                    return Result(0, _usage("kicad-cli " + argv[0] + " " + " ".join(key), values, switches, "INPUT_FILE"), "")
                return fn(rest, cwd)
    for key, what in _DESKTOP_ONLY.items():
        if tuple(argv[:len(key)]) == key:
            # The command fails, as kicad-cli does when it cannot do something, so a plugin that has another way (many
            # fall back from a 3D render to an SVG export) takes it; the reason is on stderr and in the log.
            why = f"kicad-cli {' '.join(key)}: {what} needs the KiCad desktop application"
            log.warning("%s", why)
            return Result(1, "", why + "\n")
    words = " ".join(x for x in argv[:3] if not x.startswith("-"))
    raise pcbnew.WebUnsupported(f"kicad-cli {words}: the web editor answers kicad-cli's version, pcb drc, pcb render, pcb export gerbers, drill, pos, svg and glb, and sch export netlist and bom")


# ----------------------------------------------------------------------------- git

def _repo():
    return _web().PROJECT_DIR


def _versions():
    try:
        return (_web()._call("project.versions") or {})
    except Exception as e:
        log.warning("git: the version history could not be read: %s", e)
        return {}


def git(argv, cwd=None):
    opts = []
    while argv and argv[0].startswith("-") and argv[0] not in ("--version", "--help", "-h"):
        if argv[0] in ("-C", "-c", "--git-dir", "--work-tree") and len(argv) > 1:
            if argv[0] == "-C":
                cwd = _abs(argv[1], cwd)
            argv = argv[2:]
        else:
            opts.append(argv[0])
            argv = argv[1:]
    if not argv:
        return Result(1, "usage: git [-v | --version] [-C <path>] <command> [<args>]\n", "")
    cmd, rest = argv[0], argv[1:]
    here = os.path.abspath(str(cwd or os.getcwd()))
    repo = os.path.abspath(_repo())
    inside = here == repo or here.startswith(repo + os.sep)
    if cmd in ("version", "--version"):
        return Result(0, "git version 2.47.0 (Junction version history)\n", "")
    if cmd in ("--help", "-h", "help"):
        return Result(0, "usage: git <command> [<args>]\n\nIn the web editor git stands for the project's version history: version, rev-parse, status, branch, log, add, commit, gui.\n", "")
    if not inside:
        return Result(128, "", "fatal: not a git repository (or any of the parent directories): .git\n")
    if cmd == "rev-parse":
        out = []
        for r in rest:
            if r == "--show-toplevel":
                out.append(repo)
            elif r in ("--is-inside-work-tree",):
                out.append("true")
            elif r in ("--git-dir", "--absolute-git-dir", "--git-common-dir"):
                out.append(os.path.join(repo, ".git"))
            elif r == "--show-prefix":
                out.append(os.path.relpath(here, repo).replace(os.sep, "/") + "/" if here != repo else "")
            elif r in ("--abbrev-ref", "--short", "--verify", "-q", "--quiet"):
                continue
            elif r == "HEAD":
                v = _versions()
                vs = v.get("versions") or []
                out.append((v.get("branch") or "main") if "--abbrev-ref" in rest else ((vs[0].get("id") or "").replace("-", "")[:7 if "--short" in rest else 40] if vs else "0" * 7))
        return Result(0, "\n".join(out) + ("\n" if out else ""), "")
    if cmd == "status":
        _web().flush()
        if "--porcelain" in rest or "-s" in rest or "--short" in rest:
            return Result(0, "", "")
        return Result(0, f"On branch {_versions().get('branch') or 'main'}\nnothing to commit, working tree clean (the web editor saves every change; Save Version names the project as it is now)\n", "")
    if cmd == "branch":
        return Result(0, (_versions().get("branch") or "main") + "\n" if "--show-current" in rest else "* " + (_versions().get("branch") or "main") + "\n", "")
    if cmd == "log":
        vs = [v for v in (_versions().get("versions") or []) if v.get("kind", "named") == "named" or v.get("name")]
        limit = None
        for i, r in enumerate(rest):
            if r.startswith("-") and r[1:].isdigit():
                limit = int(r[1:])
            elif r in ("-n", "--max-count") and i + 1 < len(rest) and rest[i + 1].isdigit():
                limit = int(rest[i + 1])
            elif r.startswith("--max-count="):
                limit = int(r.split("=", 1)[1] or 0)
        vs = vs[:limit] if limit is not None else vs
        one = "--oneline" in rest or any(r.startswith("--pretty=oneline") or r.startswith("--format=%h") for r in rest)
        lines = []
        for v in vs:
            sha = (v.get("id") or "").replace("-", "")
            if one:
                lines.append(f"{sha[:7]} {v.get('name') or 'Version'}")
            else:
                lines += [f"commit {sha}", f"Author: {v.get('author') or 'unknown'}", f"Date:   {v.get('createdAt') or ''}", "", f"    {v.get('name') or 'Version'}"]
                if v.get("description"):
                    lines += ["", *("    " + l for l in str(v["description"]).splitlines())]
                lines.append("")
        return Result(0, "\n".join(lines) + ("\n" if lines else ""), "")
    if cmd in ("add", "stage"):
        _web().flush()
        return Result(0, "", "")
    if cmd == "commit":
        msgs = []
        for i, r in enumerate(rest):
            if r in ("-m", "--message") and i + 1 < len(rest):
                msgs.append(rest[i + 1])
            elif r.startswith("--message="):
                msgs.append(r.split("=", 1)[1])
            elif r.startswith("-m") and len(r) > 2 and not r.startswith("--"):
                msgs.append(r[2:])
            elif r.startswith("-") and not r.startswith("--") and r.endswith("m") and i + 1 < len(rest):       # -am "message"
                msgs.append(rest[i + 1])
        _web().flush()
        name = (msgs[0].strip().splitlines() or [""])[0] if msgs else ""
        body = "\n\n".join([m for m in ["\n".join(msgs[0].strip().splitlines()[1:]).strip() if msgs else ""] + msgs[1:] if m])
        _web()._call("project.saveVersion", {"name": name, "description": body})
        return Result(0, f"[{_versions().get('branch') or 'main'}] {name}\n" if name else "", "")
    if cmd in ("gui", "citool"):
        _web().flush()
        _web()._call("project.saveVersion", {})
        return Result(0, "", "")
    if cmd in ("diff", "show", "stash", "tag", "remote", "fetch", "config", "describe", "ls-files"):
        if cmd == "config":
            return Result(1, "", "")
        if cmd == "describe":
            return Result(128, "", "fatal: No names found, cannot describe anything.\n")
        return Result(0, "", "")
    raise pcbnew.WebUnsupported(f"git {cmd}: the project's version history stands in for git in the web editor (Save Version, Branches, and GitHub sync from the project page)")


# ----------------------------------------------------------------------------- ffmpeg

_FF_VERSION = "ffmpeg version 7.1-web Copyright (c) 2000-2024 the FFmpeg developers\nbuilt for the Junction web editor: image sequences to GIF, MP4 and PNG, encoded by the browser\n"
_FF_FLAGS = {"-y", "-n", "-hide_banner", "-nostdin", "-stats", "-nostats", "-an", "-sn", "-dn", "-shortest", "-report"}
_FF_FILTERS = {"color", "overlay", "scale", "palettegen", "paletteuse", "fps", "format", "split", "null", "copy", "setsar", "pad"}


def _media():
    """The encoders (web/plugins/media.ts) in the page this interpreter runs in; None where there is no browser."""
    try:
        import js
    except ImportError:
        return None
    m = getattr(js, "__kcMedia", None)
    if m is None and hasattr(js, "document"):
        src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kicad_media.js")
        if os.path.isfile(src):
            el = js.document.createElement("script")
            with open(src, encoding="utf-8") as fh:
                el.textContent = fh.read()
            js.document.head.appendChild(el)
            m = getattr(js, "__kcMedia", None)
    return m


def _ff_inputs(pattern, start, cwd, globbed):
    path = _abs(pattern, cwd)
    if globbed:
        return sorted(_glob.glob(path))
    if "%" not in path:
        return [path] if os.path.isfile(path) else []
    out, i = [], start
    while True:
        try:
            name = path % i
        except (TypeError, ValueError):
            return []
        if not os.path.isfile(name):
            if out or i > start + 4:        # ffmpeg looks a few numbers ahead for the first frame
                break
            i += 1
            continue
        out.append(name)
        i += 1
    return out


def ffmpeg(argv, cwd=None):
    if not argv:
        return Result(1, "", _FF_VERSION + "Use -h to get full help or, even better, run 'man ffmpeg'\n")
    if argv[0] in ("-version", "--version"):
        return Result(0, _FF_VERSION, "")
    if argv[0] in ("-h", "-help", "--help", "-?"):
        return Result(0, "usage: ffmpeg [options] [[infile options] -i infile]... {[outfile options] outfile}...\n", _FF_VERSION)
    if argv[0] in ("-encoders", "-codecs", "-formats", "-muxers"):
        return Result(0, " V..... libx264              H.264 (the browser's encoder)\n V..... gif                  GIF (Graphics Interchange Format)\n V..... png                  PNG (Portable Network Graphics) image\n", _FF_VERSION)
    # options before an -i belong to that input; the ones after the last -i to the output
    inputs, pending, outputs = [], {}, []
    i = 0
    while i < len(argv):
        a = str(argv[i])
        i += 1
        if a in _FF_FLAGS:
            continue
        if a == "-i":
            if i >= len(argv):
                return Result(1, "", "Missing argument for option 'i'.\n")
            inputs.append((str(argv[i]), pending))
            pending = {}
            i += 1
        elif a.startswith("-") and len(a) > 1:
            if i >= len(argv):
                return Result(1, "", f"Missing argument for option '{a[1:]}'.\n")
            pending[a] = str(argv[i])
            i += 1
        else:
            outputs.append(a)
    opts = pending
    if not inputs:
        return Result(1, "", "At least one input file must be specified\n")
    if len(outputs) != 1:
        return Result(1, "", "At least one output file must be specified\n" if not outputs else "The web editor's ffmpeg writes one output file at a time\n")
    out = _abs(outputs[0], cwd)
    ext = os.path.splitext(out)[1].lower()
    graph = opts.get("-filter_complex") or opts.get("-lavfi") or opts.get("-vf") or opts.get("-filter:v") or ""
    import re
    names = set(re.findall(r"(?:^|[;,\]])\s*([a-z_0-9]+)\s*(?==|[;,\[]|$)", graph))
    odd = sorted(n for n in names if n not in _FF_FILTERS)
    if odd:
        return Result(1, "", f"No such filter: '{odd[0]}' (the web editor's ffmpeg has: {', '.join(sorted(_FF_FILTERS))})\n")
    pattern, first = inputs[0]
    frames = _ff_inputs(pattern, int(first.get("-start_number", "0") or 0), cwd, first.get("-pattern_type") == "glob")
    if not frames:
        return Result(1, "", f"{pattern}: No such file or directory\n")
    if not frames[0].lower().endswith((".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif")):
        return Result(1, "", f"{pattern}: the web editor's ffmpeg reads pictures (PNG or JPEG frames), not video or audio files\n")
    def rate(text, default):
        try:
            if "/" in str(text):
                n, d = str(text).split("/", 1)
                return float(n) / float(d)
            return float(text)
        except (TypeError, ValueError, ZeroDivisionError):
            return default
    fps = rate(first.get("-framerate") or first.get("-r"), 25.0)
    m = re.search(r"(?:^|[;,\]])\s*fps=(?:fps=)?([0-9./]+)", graph)
    out_fps = rate(opts.get("-r") or (m.group(1) if m else None), fps)
    if out_fps != fps and out_fps > 0:      # frames are dropped or repeated to the output rate, the clip keeps its length
        count = max(1, int(round(len(frames) * out_fps / fps)))
        frames = [frames[min(len(frames) - 1, int(k * fps / out_fps))] for k in range(count)]
    if "-frames:v" in opts or "-vframes" in opts:
        try:
            frames = frames[:max(1, int(opts.get("-frames:v") or opts.get("-vframes")))]
        except ValueError:
            pass
    job = {"fps": out_fps or fps}
    m = re.search(r"color=(?:c(?:olor)?=)?([#0-9A-Za-z]+)", graph)
    if m:
        c = m.group(1)
        named = {"black": "#000000", "white": "#ffffff", "red": "#ff0000", "green": "#008000", "blue": "#0000ff", "gray": "#808080", "grey": "#808080"}
        c = named.get(c.lower(), c)
        if c.lower().startswith("0x"):
            c = "#" + c[2:]
        if re.fullmatch(r"#[0-9A-Fa-f]{6}", c[:7]):
            job["background"] = c[:7]
    m = re.search(r"color=[^;\[]*?s=(\d+)x(\d+)", graph) or re.search(r"(?:^|[;,\]])\s*scale=(\d+):(\d+)", graph) or re.fullmatch(r"(\d+)x(\d+)", opts.get("-s", ""))
    if m:
        job["width"], job["height"] = int(m.group(1)), int(m.group(2))
    if "trunc(iw/2)*2" in graph or opts.get("-pix_fmt") == "yuv420p":
        job["even"] = True
    palette = None
    if ext == ".gif":
        job["format"] = "gif"
        if "-loop" in opts:
            try:
                job["loop"] = int(opts["-loop"])
            except ValueError:
                pass
        if "paletteuse" in names and len(inputs) > 1:
            pal = _abs(inputs[1][0], cwd)
            if not os.path.isfile(pal):
                return Result(1, "", f"{inputs[1][0]}: No such file or directory\n")
            with open(pal, "rb") as fh:
                palette = fh.read()
        if "dither=none" in graph:
            job["dither"] = False
    elif ext in (".mp4", ".m4v", ".mov"):
        codec = opts.get("-c:v") or opts.get("-vcodec") or opts.get("-codec:v") or "libx264"
        if codec not in ("libx264", "h264", "libopenh264", "h264_videotoolbox", "h264_nvenc", "libvpx-vp9", "libaom-av1", "libsvtav1"):
            return Result(1, "", f"Unknown encoder '{codec}'\n")
        job["format"] = "mp4"
        job["even"] = True
        try:
            job["crf"] = float(opts.get("-crf", "23"))
        except ValueError:
            pass
    elif ext == ".png":
        job["format"] = "palette" if "palettegen" in names else "png"
        m = re.search(r"max_colors=(\d+)", graph)
        if m:
            job["maxColors"] = int(m.group(1))
    else:
        return Result(1, "", f"Unable to choose an output format for '{outputs[0]}'; the web editor's ffmpeg writes .gif, .mp4 and .png\n")
    if os.path.exists(out) and "-n" in argv:
        return Result(1, "", f"File '{out}' already exists. Exiting.\n")
    media = _media()
    if media is None:
        return Result(1, "", "ffmpeg: the pictures are encoded by the browser the editor runs in, and there is none here\n")
    try:
        data, codec = _encode(media, job, frames, palette)
    except Exception as e:
        return Result(1, "", f"Conversion failed! {str(e).splitlines()[-1] if str(e) else type(e).__name__}\n")
    _write(out, data)
    note = ""
    if job["format"] == "mp4" and not str(codec).startswith("avc1"):
        note = f"This browser has no H.264 encoder: the MP4 holds {'VP9' if str(codec).startswith('vp09') else 'AV1'} video ({codec}), which browsers and VLC play.\n"
    return Result(0, "", _FF_VERSION + f"Output #0, {job['format']}, to '{out}': {len(frames)} frames at {job['fps']:g} fps, {len(data)} bytes ({codec})\n" + note)


def _encode(media, job, frames, palette):
    """Hand the frames to the page's encoders and wait for the file."""
    import js
    from pyodide.ffi import run_sync, to_js
    sync = getattr(media, "runSync", None)
    if sync is not None:        # the test harness: a browser is started for the job, which reads the frames from disk
        res = json.loads(str(sync(json.dumps(dict(job, frames=frames, palette=None if palette is None else list(palette))))))
        import base64
        return base64.b64decode(res["base64"]), res.get("codec", "")
    opt = js.Object.fromEntries(to_js([[k, v] for k, v in job.items()]))
    if palette is not None:
        opt.palette = to_js(palette)
    handle = media.open(opt)
    web = _web()
    for n, path in enumerate(frames):
        with open(path, "rb") as fh:
            handle.add(to_js(fh.read()))
        if n % 20 == 0:
            web._yield() if hasattr(web, "_yield") else None
    res = run_sync(handle.finish())
    return bytes(res.bytes.to_py()), str(res.codec)


def which(name):
    """shutil.which for the programs answered here."""
    return PROGRAMS.get(os.path.basename(str(name)).lower())


def run(name, argv, cwd=None):
    """Run one of the programs; None when `name` is not one of them."""
    base = os.path.basename(str(name)).lower()
    if base in ("kicad-cli", "kicad-cli.exe", "kicad-cli-nightly"):
        return kicad_cli(list(argv), cwd)
    if base in ("git", "git.exe"):
        return git(list(argv), cwd)
    if base in ("ffmpeg", "ffmpeg.exe"):
        return ffmpeg(list(argv), cwd)
    if base == "xdg-user-dir":       # where the person's Downloads, Documents, … are: folders of this interpreter's home
        kind = (list(argv) + ["HOME"])[0].upper()
        home = os.path.expanduser("~")
        names = {"DESKTOP": "Desktop", "DOWNLOAD": "Downloads", "DOCUMENTS": "Documents", "PICTURES": "Pictures", "MUSIC": "Music",
                 "VIDEOS": "Videos", "TEMPLATES": "Templates", "PUBLICSHARE": "Public"}
        folder = os.path.join(home, names[kind]) if kind in names else home
        os.makedirs(folder, exist_ok=True)
        return Result(0, folder + "\n", "")
    if base in ("ngspice", "ngspice.exe", "ngspice_con.exe"):
        import kicad_spice
        try:
            return Result(*kicad_spice.ngspice(list(argv), cwd))
        except kicad_spice.Unavailable as e:
            return Result(1, "", f"ngspice: {e}\n")
    return None
