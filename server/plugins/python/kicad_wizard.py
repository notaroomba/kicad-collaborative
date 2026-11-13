"""The footprint wizard dialog.

KiCad runs footprint wizards from its footprint editor: a list of parameter pages on the left, the footprint drawn on
the right, and a button that hands the result over.  The web editor offers every wizard a plugin registers as a
command of its own ("Footprint Wizard: <name>") that opens the same thing as a dialog: change a value and the
footprint is rebuilt and redrawn; "Place on Board" adds it to the open board, "Save Footprint" writes a .kicad_mod.
"""

import base64
import html
import math

import pcbnew
import wx

# KiCad's default board colours (web/canvas/colors.ts holds the same table for the editor's canvas).
_COLORS = {"F.Cu": "#C83434", "B.Cu": "#4D7FC4", "F.SilkS": "#F2EDA1", "B.SilkS": "#E8B2A7", "F.Mask": "#D864FF", "B.Mask": "#02FFEE", "F.Paste": "#B4A09A", "B.Paste": "#00C2C2",
           "F.Adhes": "#840084", "B.Adhes": "#000084", "Edge.Cuts": "#D0D2CD", "Margin": "#FF26E2", "F.CrtYd": "#FF26E2", "B.CrtYd": "#26E9FF", "F.Fab": "#AFAFAF", "B.Fab": "#585D84",
           "Dwgs.User": "#C2C2C2", "Cmts.User": "#5994DC", "Eco1.User": "#B4DBD2", "Eco2.User": "#D8C852"}
_INNER = ["#7FC87F", "#CE7D2C", "#4FCBCB", "#DB628B", "#A7A5C6", "#28CCD9", "#E8B2A7", "#F2EDA1", "#8DCB81", "#ED7C33"]
_USER = ["#C2C2C2", "#5994DC", "#B4DBD2", "#D8C852"]
_BG, _PAD, _HOLE = "#001023", "#C83434", "#001023"


def _color(layer):
    if layer in _COLORS:
        return _COLORS[layer]
    if layer.startswith("In") and layer.endswith(".Cu"):
        try:
            return _INNER[(int(layer[2:-3]) - 1) % len(_INNER)]
        except ValueError:
            return "#7FC87F"
    if layer.startswith("User."):
        try:
            return _USER[(int(layer[5:]) - 1) % len(_USER)]
        except ValueError:
            pass
    return "#C2C2C2"


def _mm(v):
    return pcbnew.ToMM(v)


def _f(v):
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


class _Box:
    def __init__(self):
        self.x0 = self.y0 = math.inf
        self.x1 = self.y1 = -math.inf

    def add(self, x, y, r=0.0):
        self.x0, self.y0 = min(self.x0, x - r), min(self.y0, y - r)
        self.x1, self.y1 = max(self.x1, x + r), max(self.y1, y + r)


def footprint_svg(fp):
    """The footprint as an SVG drawing, in millimetres, in KiCad's layer colours."""
    box = _Box()
    out = []
    shapes = sorted(list(fp.GraphicalItems()), key=lambda s: 0 if not s.GetLayerName().endswith(".Cu") else 1)
    for s in shapes:
        if not hasattr(s, "GetShape"):
            continue
        layer = s.GetLayerName()
        col = _color(layer)
        w = max(_mm(s.GetWidth()), 0.0)
        filled = bool(s.IsFilled()) if hasattr(s, "IsFilled") else False
        style = f'stroke="{col}" stroke-width="{_f(w or 0.05)}" stroke-linecap="round" stroke-linejoin="round" fill="{col if filled else "none"}"'
        kind = s.GetShape()
        if kind == pcbnew.SHAPE_T_SEGMENT:
            a, b = s.GetStart(), s.GetEnd()
            x1, y1, x2, y2 = _mm(a.x), _mm(a.y), _mm(b.x), _mm(b.y)
            box.add(x1, y1, w / 2)
            box.add(x2, y2, w / 2)
            out.append(f'<line x1="{_f(x1)}" y1="{_f(y1)}" x2="{_f(x2)}" y2="{_f(y2)}" {style}/>')
        elif kind == pcbnew.SHAPE_T_CIRCLE:
            c = s.GetCenter()
            r = _mm(s.GetRadius())
            box.add(_mm(c.x), _mm(c.y), r + w / 2)
            out.append(f'<circle cx="{_f(_mm(c.x))}" cy="{_f(_mm(c.y))}" r="{_f(r)}" {style}/>')
        elif kind == pcbnew.SHAPE_T_ARC:
            a, m, b, c = s.GetStart(), s.GetArcMid(), s.GetEnd(), s.GetCenter()
            r = _mm(s.GetRadius())
            x1, y1, xm, ym, x2, y2 = _mm(a.x), _mm(a.y), _mm(m.x), _mm(m.y), _mm(b.x), _mm(b.y)
            box.add(_mm(c.x), _mm(c.y), r + w / 2)
            cx, cy = _mm(c.x), _mm(c.y)
            sweep = 1 if (x1 - cx) * (ym - cy) - (y1 - cy) * (xm - cx) > 0 else 0          # the way round from the start to the middle, as drawn (Y down)
            # two half arcs through the middle point: no large-arc ambiguity, and a full turn still draws
            out.append(f'<path d="M{_f(x1)} {_f(y1)} A{_f(r)} {_f(r)} 0 0 {sweep} {_f(xm)} {_f(ym)} A{_f(r)} {_f(r)} 0 0 {sweep} {_f(x2)} {_f(y2)}" {style}/>')
        elif kind in (pcbnew.SHAPE_T_RECT, pcbnew.SHAPE_T_RECTANGLE):
            a, b = s.GetStart(), s.GetEnd()
            x1, y1, x2, y2 = sorted((_mm(a.x), _mm(b.x)))[0], sorted((_mm(a.y), _mm(b.y)))[0], sorted((_mm(a.x), _mm(b.x)))[1], sorted((_mm(a.y), _mm(b.y)))[1]
            box.add(x1, y1, w / 2)
            box.add(x2, y2, w / 2)
            out.append(f'<rect x="{_f(x1)}" y="{_f(y1)}" width="{_f(x2 - x1)}" height="{_f(y2 - y1)}" {style}/>')
        elif kind == pcbnew.SHAPE_T_POLY:
            pts = [(_mm(p.x), _mm(p.y)) for p in s.GetPolyPoints()]
            if len(pts) >= 2:
                for x, y in pts:
                    box.add(x, y, w / 2)
                fill = col if filled or not w else "none"
                out.append(f'<polygon points="{" ".join(_f(x) + "," + _f(y) for x, y in pts)}" stroke="{col}" stroke-width="{_f(w)}" stroke-linejoin="round" fill="{fill}"/>')
    for p in fp.Pads():
        pos, size, drill = p.GetPosition(), p.GetSize(), p.GetDrillSize()
        x, y, sx, sy = _mm(pos.x), _mm(pos.y), _mm(size.x), _mm(size.y)
        rot = -p.GetOrientationDegrees()
        box.add(x, y, max(sx, sy) / 2)
        npth = p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH
        col = "#1AC4D2" if npth else _PAD
        shape = p.GetShape()
        g = f'<g transform="translate({_f(x)} {_f(y)}) rotate({_f(rot)})">'
        if shape == pcbnew.PAD_SHAPE_CIRCLE:
            g += f'<circle r="{_f(sx / 2)}" fill="{col}"/>'
        elif shape == pcbnew.PAD_SHAPE_OVAL:
            g += f'<rect x="{_f(-sx / 2)}" y="{_f(-sy / 2)}" width="{_f(sx)}" height="{_f(sy)}" rx="{_f(min(sx, sy) / 2)}" fill="{col}"/>'
        elif shape == pcbnew.PAD_SHAPE_ROUNDRECT:
            g += f'<rect x="{_f(-sx / 2)}" y="{_f(-sy / 2)}" width="{_f(sx)}" height="{_f(sy)}" rx="{_f(min(sx, sy) * (p.GetRoundRectRadiusRatio() or 0.25))}" fill="{col}"/>'
        else:
            g += f'<rect x="{_f(-sx / 2)}" y="{_f(-sy / 2)}" width="{_f(sx)}" height="{_f(sy)}" fill="{col}"/>'
        dx, dy = _mm(drill.x), _mm(drill.y)
        if dx > 0:
            g += f'<rect x="{_f(-dx / 2)}" y="{_f(-(dy or dx) / 2)}" width="{_f(dx)}" height="{_f(dy or dx)}" rx="{_f(min(dx, dy or dx) / 2)}" fill="{_HOLE}"/>'
        num = str(p.GetNumber())
        if num:
            h = max(min(sx, sy) * 0.5, 0.2) if not dx else max(min(sx, sy) * 0.3, 0.2)
            g += f'<text text-anchor="middle" dominant-baseline="central" font-size="{_f(h)}" fill="#FFFFFF" font-family="sans-serif" transform="rotate({_f(-rot)})">{html.escape(num)}</text>'
        out.append(g + "</g>")
    for field in (fp.Reference(), fp.Value()):
        try:
            if not field.IsVisible():
                continue
            pos, size = field.GetPosition(), field.GetTextSize()
            x, y, h = _mm(pos.x), _mm(pos.y), _mm(size.y)
            text = str(field.GetText())
            box.add(x, y, max(h, len(text) * h * 0.4))
            out.append(f'<text x="{_f(x)}" y="{_f(y)}" text-anchor="middle" dominant-baseline="central" font-size="{_f(h * 1.3)}" fill="{_color(field.GetLayerName())}" font-family="sans-serif" '
                       f'transform="rotate({_f(-field.GetTextAngleDegrees())} {_f(x)} {_f(y)})">{html.escape(text)}</text>')
        except Exception:
            pass
    if not math.isfinite(box.x0):
        box.add(-5, -5)
        box.add(5, 5)
    pad = max((box.x1 - box.x0), (box.y1 - box.y0)) * 0.06 + 0.5
    vx, vy, vw, vh = box.x0 - pad, box.y0 - pad, box.x1 - box.x0 + 2 * pad, box.y1 - box.y0 + 2 * pad
    cross = max(vw, vh) * 0.02
    axes = (f'<path d="M{_f(-cross)} 0 H{_f(cross)} M0 {_f(-cross)} V{_f(cross)}" stroke="#848484" stroke-width="{_f(max(vw, vh) * 0.002)}" fill="none"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{_f(vx)} {_f(vy)} {_f(vw)} {_f(vh)}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block;background:{_BG}">'
            + axes + "".join(out) + "</svg>"), (box.x1 - box.x0, box.y1 - box.y0)


def footprint_file(fp):
    """The footprint as a .kicad_mod library file."""
    node = fp._node
    name = str(fp.GetFPID().GetLibItemName()) or str(fp.GetValue()) or "footprint"
    body = [c for c in node[2:] if not (isinstance(c, list) and c and str(c[0]) in ("at", "uuid", "path", "sheetname", "sheetfile", "locked", "placed"))]
    head = ["(footprint " + pcbnew._quote(name), "  (version 20241229)", '  (generator "kicad_collaborative_wizard")', '  (generator_version "10.0")']
    return pcbnew._prettify(" ".join(head + [pcbnew._dump(c) for c in body]) + ")"), name


def _safe_name(name):
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in str(name)).strip("_") or "footprint"


def _place(fp, web):
    """Add the built footprint to the open board: in the middle of the board's outline, or of the page when it has none."""
    board = pcbnew.GetBoard()
    x, y = 148.5, 105.0
    try:
        bb = board.GetBoardEdgesBoundingBox()
        if bb.GetWidth() > 0 and bb.GetHeight() > 0:
            c = bb.GetCenter()
            x, y = _mm(c.x), _mm(c.y)
    except Exception:
        pass
    at = pcbnew._kid(fp._node, "at")
    if at is None:
        fp._node.append([pcbnew.Sym("at"), x, y])
    else:
        at[1:3] = [x, y]
    board.Add(fp)
    web.flush()
    try:
        web._call("view.select", {"ids": [fp.m_Uuid.AsString()]})
        web._call("view.focus", {"ids": [fp.m_Uuid.AsString()]})
    except Exception:
        pass


class WizardDialog(wx.Dialog):
    def __init__(self, wizard):
        wx.Dialog.__init__(self, None, title="Footprint Wizard: " + str(wizard.GetName()), size=(900, 600), style=wx.DEFAULT_DIALOG_STYLE | wx.RESIZE_BORDER)
        self.wizard = wizard
        self.controls = []          # (parameter, control)
        self.built = None
        outer = wx.BoxSizer(wx.VERTICAL)
        desc = wx.StaticText(self, label=str(wizard.GetDescription() or ""))
        outer.Add(desc, 0, wx.ALL | wx.EXPAND, 6)
        row = wx.BoxSizer(wx.HORIZONTAL)
        self.book = wx.Notebook(self)
        self.book.SetMinSize((360, 300))
        for page in wizard.pages:
            panel = wx.ScrolledWindow(self.book)
            grid = wx.FlexGridSizer(cols=3, vgap=4, hgap=8)
            grid.AddGrowableCol(1, 1)
            for p in wizard.GetParametersByPageName(page):
                label = wx.StaticText(panel, label=str(p.name))
                units = str(p.units)
                if units == pcbnew.uBool:
                    ctrl = wx.CheckBox(panel)
                    ctrl.SetValue(str(p.raw_value) == "1")
                    ctrl.Bind(wx.EVT_CHECKBOX, self.on_change)
                    unit = ""
                elif "," in units:
                    ctrl = wx.Choice(panel, choices=units.split(","))
                    ctrl.SetStringSelection(str(p.raw_value))
                    ctrl.Bind(wx.EVT_CHOICE, self.on_change)
                    unit = ""
                else:
                    ctrl = wx.TextCtrl(panel, value=str(p.raw_value))
                    ctrl.Bind(wx.EVT_TEXT, self.on_change)
                    unit = {pcbnew.uString: "", pcbnew.uFloat: "", pcbnew.uInteger: "", pcbnew.uDegrees: "deg", pcbnew.uRadians: "rad"}.get(units, units)
                if p.hint:
                    label.SetToolTip(str(p.hint))
                    ctrl.SetToolTip(str(p.hint))
                grid.Add(label, 0, wx.ALIGN_CENTER_VERTICAL)
                grid.Add(ctrl, 1, wx.EXPAND)
                grid.Add(wx.StaticText(panel, label=unit), 0, wx.ALIGN_CENTER_VERTICAL)
                self.controls.append((p, ctrl))
            box = wx.BoxSizer(wx.VERTICAL)
            box.Add(grid, 0, wx.ALL | wx.EXPAND, 8)
            panel.SetSizer(box)
            self.book.AddPage(panel, str(page))
        row.Add(self.book, 0, wx.EXPAND | wx.RIGHT, 8)
        self.preview = wx.Panel(self)
        self.preview.SetMinSize((440, 360))
        try:
            st = self.preview.el.style
            st.flex, st.minWidth, st.overflow, st.border, st.borderRadius = "1 1 0", "0", "hidden", "1px solid var(--line)", "3px"
        except Exception:
            pass
        row.Add(self.preview, 1, wx.EXPAND)
        outer.Add(row, 1, wx.EXPAND | wx.LEFT | wx.RIGHT, 6)
        self.size_label = wx.StaticText(self, label="")
        outer.Add(self.size_label, 0, wx.LEFT | wx.RIGHT | wx.TOP, 6)
        self.messages = wx.TextCtrl(self, style=wx.TE_MULTILINE | wx.TE_READONLY)
        self.messages.SetMinSize((-1, 96))
        outer.Add(self.messages, 0, wx.ALL | wx.EXPAND, 6)
        buttons = wx.BoxSizer(wx.HORIZONTAL)
        reset = wx.Button(self, label="Reset to Defaults")
        reset.Bind(wx.EVT_BUTTON, self.on_reset)
        buttons.Add(reset, 0)
        buttons.AddStretchSpacer(1)
        self.save = wx.Button(self, label="Save Footprint...")
        self.save.Bind(wx.EVT_BUTTON, self.on_save)
        buttons.Add(self.save, 0, wx.RIGHT, 6)
        self.place = wx.Button(self, wx.ID_OK, label="Place on Board")
        self.place.SetDefault()
        buttons.Add(self.place, 0, wx.RIGHT, 6)
        buttons.Add(wx.Button(self, wx.ID_CANCEL, label="Close"), 0)
        outer.Add(buttons, 0, wx.ALL | wx.EXPAND, 6)
        self.SetSizer(outer)
        self.rebuild()

    def read(self):
        for p, ctrl in self.controls:
            if isinstance(ctrl, wx.CheckBox):
                p.SetValue("1" if ctrl.GetValue() else "0")
            elif isinstance(ctrl, wx.Choice):
                p.SetValue(ctrl.GetStringSelection())
            else:
                p.SetValue(ctrl.GetValue())

    def rebuild(self):
        w = self.wizard
        self.built = None
        try:
            w.BuildFootprint()
            text = str(w.GetBuildMessages() or "")
            ok = not w.AnyErrors() and w.module is not None
        except Exception as e:                         # a wizard that fails on these values: its own message, nothing placed
            text, ok = f"The wizard could not build a footprint from these values: {type(e).__name__}: {e}", False
        svg, size = "", None
        if ok:
            try:
                svg, size = footprint_svg(w.module)
                self.built = w.module
            except Exception as e:
                text += f"\nThe preview could not be drawn: {type(e).__name__}: {e}"
                self.built = w.module
        try:
            self.preview.el.innerHTML = svg
        except Exception:
            pass
        self.messages.SetValue(text)
        if self.built is None:
            import logging
            logging.getLogger("kicad_web").warning("footprint wizard: %s", text.strip()[:600])
        if self.built is not None and size:
            pads = len(list(self.built.Pads()))
            self.size_label.SetLabel(f"{pcbnew._num(round(size[0], 3))} x {pcbnew._num(round(size[1], 3))} mm, {pads} pad{'s' if pads != 1 else ''}")
        else:
            self.size_label.SetLabel("" if ok else "Fix the values marked in the messages below to build the footprint.")
        self.place.Enable(self.built is not None)
        self.save.Enable(self.built is not None)

    def on_change(self, event):
        self.read()
        self.rebuild()

    def on_reset(self, event):
        self.wizard.ResetWizard()
        for p, ctrl in self.controls:
            if isinstance(ctrl, wx.CheckBox):
                ctrl.SetValue(str(p.raw_value) == "1")
            elif isinstance(ctrl, wx.Choice):
                ctrl.SetStringSelection(str(p.raw_value))
            else:
                ctrl.ChangeValue(str(p.raw_value)) if hasattr(ctrl, "ChangeValue") else ctrl.SetValue(str(p.raw_value))
        self.rebuild()

    def on_save(self, event):
        if self.built is None:
            return
        import kicad_web
        text, name = footprint_file(self.built)
        kicad_web._call("files.save", {"filename": _safe_name(name) + ".kicad_mod", "base64": base64.b64encode(text.encode("utf-8")).decode("ascii"), "mime": "text/plain"})


class WizardAction:
    """A registered footprint wizard, offered as one of the plugin's commands."""

    def __init__(self, wizard):
        self.wizard = wizard
        self.name = "Footprint Wizard: " + str(wizard.GetName())
        self.description = str(wizard.GetDescription() or "")
        self.category = "Footprint Wizard"
        self.show_toolbar_button = False
        self.icon_file_name = self.dark_icon_file_name = ""

    def GetName(self):
        return self.name

    def Run(self):
        import kicad_web
        dlg = WizardDialog(self.wizard)
        try:
            if dlg.ShowModal() == wx.ID_OK and dlg.built is not None:
                # what is placed is a footprint of its own: the wizard builds a new one for the next run
                _place(dlg.built, kicad_web)
                self.wizard.module = None
        finally:
            dlg.Destroy()


def _web_pages(w):
    """The wizard's parameter pages as the footprint editor's wizard dialog lists them (FOOTPRINT_WIZARD_FRAME's
    parameter grid: Parameter / Value / Units, a page per tab), with each value's errors."""
    pages = []
    for i in range(w.GetNumParameterPages()):
        params = []
        for p in w.GetParametersByPageIndex(i):
            params.append({"name": str(p.name), "value": str(p.raw_value), "units": str(p.units), "hint": str(p.hint or ""),
                           "designator": str(p.designator or "").strip(), "error": "\n".join(str(e) for e in p.error_list)})
        pages.append({"name": str(w.GetParameterPageName(i)), "params": params})
    return pages


def web_op(w, req):
    """One request of the footprint editor's wizard dialog: "describe" (the values as they stand), "build" (the
    values of every page, then a build) or "reset" (ResetWizard).  Every answer builds the footprint and carries
    the pages, the build messages and the footprint as a .kicad_mod (None when the wizard reported errors)."""
    op = str(req.get("op") or "describe")
    if op == "reset":
        w.ResetWizard()
    elif op == "build":
        values = req.get("values") or []
        for i in range(min(len(values), w.GetNumParameterPages())):
            if isinstance(values[i], list):
                w.SetParameterValues(i, [str(v) for v in values[i]])
    w.module = None
    footprint = None
    try:
        w.BuildFootprint()
        text = str(w.GetBuildMessages() or "")
        if not w.AnyErrors() and w.module is not None:
            footprint = footprint_file(w.module)[0]
    except Exception as e:                         # a wizard that fails on these values: its own message, nothing built
        text = f"The wizard could not build a footprint from these values: {type(e).__name__}: {e}"
    return {"name": str(w.GetName()), "description": str(w.GetDescription() or ""), "pages": _web_pages(w), "messages": text, "footprint": footprint}
