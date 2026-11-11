"""FootprintWizardBase: KiCad's helper module for footprint wizards.

A footprint wizard is a Python class that builds a footprint from a table of parameters (a coil, a connector row,
a dial scale).  KiCad runs it from the footprint editor; the web editor lists every wizard a plugin registers as a
command of its own, which opens the wizard dialog (kicad_wizard.py): the parameter pages, a preview, and buttons to
place the footprint on the board or save it as a .kicad_mod file.

This module carries the same classes and methods KiCad's own FootprintWizardBase.py does, so a wizard written for
the desktop runs unchanged.
"""

import math

import pcbnew


class FootprintWizard(pcbnew.FootprintWizardPlugin):
    """The base of a wizard: implement GetName, GetDescription, GetValue, GenerateParameterList, CheckParameters and
    BuildThisFootprint; `self.parameters[page][name]` holds the values and `self.draw` the drawing helper."""

    uMM, uMils, uFloat, uInteger, uBool = pcbnew.uMM, pcbnew.uMils, pcbnew.uFloat, pcbnew.uInteger, pcbnew.uBool
    uRadians, uDegrees, uPercent, uString = pcbnew.uRadians, pcbnew.uDegrees, pcbnew.uPercent, pcbnew.uString

    def __init__(self):
        pcbnew.FootprintWizardPlugin.__init__(self)
        self.GenerateParameterList()

    def GetName(self):
        raise NotImplementedError

    def GetDescription(self):
        raise NotImplementedError

    def GetValue(self):
        raise NotImplementedError

    def GetReferencePrefix(self):
        return "REF"

    def GetImage(self):
        return ""

    def GenerateParameterList(self):
        raise NotImplementedError

    def CheckParameters(self):
        raise NotImplementedError

    def BuildThisFootprint(self):
        raise NotImplementedError

    def BuildFootprint(self):
        """Check the parameters, then make a new footprint and let the wizard draw it."""
        self.buildmessages = ""
        self.module = pcbnew.FOOTPRINT(None)
        for p in self.params:
            p.ClearErrors()
            p.Check()
        self.CheckParameters()
        if self.AnyErrors():
            self.buildmessages = "Cannot build footprint: Parameters have errors:\n"
            for p in self.params:
                if p.error_list:
                    self.buildmessages += "['{page}']['{name}']:\n".format(page=p.page, name=p.name)
                    for error in p.error_list:
                        self.buildmessages += "\t" + error + "\n"
            return
        self.buildmessages = "Building new {name} footprint with the following parameters:\n".format(name=self.name)
        self.buildmessages += self.Show()
        self.draw = FootprintWizardDrawingAids(self.module)
        self.module.SetValue(self.GetValue())
        self.module.SetReference("%s**" % self.GetReferencePrefix())
        self.module.SetFPID(pcbnew.LIB_ID("", self.GetValue()))
        self.SetModule3DModel()
        thick = self.GetTextThickness()
        self.module.Reference().SetTextThickness(thick)
        self.module.Value().SetTextThickness(thick)
        self.BuildThisFootprint()

    def SetModule3DModel(self):
        pass

    def GetTextSize(self):
        return pcbnew.FromMM(1.0)

    def GetTextThickness(self):
        return pcbnew.FromMM(0.15)


class FootprintWizardDrawingAids:
    """Lines, circles, arcs and boxes on the footprint being built, through a stack of transforms."""

    dirN, dirNE, dirE, dirSE, dirS, dirSW, dirW, dirNW = 0, 45, 90, 135, 180, 225, 270, 315
    flipNone, flipX, flipY, flipBoth = 0, 1, 2, 3
    xfrmIDENTITY = [1, 0, 0, 0, 1, 0]
    defaultLineThickness = pcbnew.FromMM(0.15)

    def DefaultGraphicLayer(self):
        return pcbnew.F_SilkS

    def DefaultTextValueLayer(self):
        return pcbnew.F_Fab

    def __init__(self, module):
        self.module = module
        self.dc = {"layer": self.DefaultGraphicLayer(), "lineThickness": self.defaultLineThickness, "transforms": [], "transform": self.xfrmIDENTITY}

    # -- transforms
    def PushTransform(self, mat):
        self.dc["transforms"].append(mat)
        self.RecomputeTransforms()

    def PopTransform(self, num=1):
        mat = None
        for _ in range(num):
            mat = self.dc["transforms"].pop()
        self.RecomputeTransforms()
        return mat

    def ResetTransform(self):
        self.dc["transforms"] = []
        self.RecomputeTransforms()

    def _ComposeMatricesWithIdentity(self, mats):
        x = self.xfrmIDENTITY
        for mat in mats:
            x = [x[0] * mat[0] + x[1] * mat[3], x[0] * mat[1] + x[1] * mat[4], x[0] * mat[2] + x[1] * mat[5] + x[2],
                 x[3] * mat[0] + x[4] * mat[3], x[3] * mat[1] + x[4] * mat[4], x[3] * mat[2] + x[4] * mat[5] + x[5]]
        return x

    def RecomputeTransforms(self):
        self.dc["transform"] = self._ComposeMatricesWithIdentity(self.dc["transforms"])

    def TransformTranslate(self, x, y, push=True):
        mat = [1, 0, x, 0, 1, y]
        if push:
            self.PushTransform(mat)
        return mat

    def TransformFlipOrigin(self, flip, push=True):
        mat = {self.flipX: [-1, 0, 0, 0, 1, 0], self.flipY: [1, 0, 0, 0, -1, 0], self.flipBoth: [-1, 0, 0, 0, -1, 0]}.get(flip, self.xfrmIDENTITY)
        if push:
            self.PushTransform(mat)
        return mat

    def TransformFlip(self, x, y, flip=flipNone, push=True):
        mat = self._ComposeMatricesWithIdentity([self.TransformTranslate(x, y, push=False), self.TransformFlipOrigin(flip, push=False), self.TransformTranslate(-x, -y, push=False)])
        if push:
            self.PushTransform(mat)
        return mat

    def TransformRotationOrigin(self, rot, push=True):
        rads = rot * math.pi / 180
        mat = [math.cos(rads), -math.sin(rads), 0, math.sin(rads), math.cos(rads), 0]
        if push:
            self.PushTransform(mat)
        return mat

    def TransformRotation(self, x, y, rot, push=True):
        mat = self._ComposeMatricesWithIdentity([self.TransformTranslate(x, y, push=False), self.TransformRotationOrigin(rot, push=False), self.TransformTranslate(-x, -y, push=False)])
        if push:
            self.PushTransform(mat)
        return mat

    def TransformScaleOrigin(self, sx, sy=None, push=True):
        if sy is None:
            sy = sx
        mat = [sx, 0, 0, 0, sy, 0]
        if push:
            self.PushTransform(mat)
        return mat

    def TransformPoint(self, x, y, mat=None):
        if not mat:
            mat = self.dc["transform"]
        return pcbnew.VECTOR2I(int(x * mat[0] + y * mat[1] + mat[2]), int(x * mat[3] + y * mat[4] + mat[5]))

    # -- pen
    def SetLineThickness(self, lineThickness):
        self.dc["lineThickness"] = lineThickness

    SetLineTickness = SetLineThickness           # KiCad's own old spelling, still used by wizards

    def GetLineThickness(self):
        return self.dc["lineThickness"]

    GetLineTickness = GetLineThickness

    def SetLayer(self, layer):
        self.dc["layer"] = layer

    def GetLayer(self):
        return self.dc["layer"]

    # -- shapes
    def _shape(self, kind):
        s = pcbnew.PCB_SHAPE(self.module)
        s.SetShape(kind)
        s.SetWidth(int(self.dc["lineThickness"]))
        s.SetLayer(self.dc["layer"])
        return s

    def Line(self, x1, y1, x2, y2):
        outline = self._shape(pcbnew.SHAPE_T_SEGMENT)
        outline.SetStart(self.TransformPoint(x1, y1))
        outline.SetEnd(self.TransformPoint(x2, y2))
        self.module.Add(outline)

    def Circle(self, x, y, r, filled=False):
        circle = self._shape(pcbnew.SHAPE_T_CIRCLE)
        circle.SetCenter(self.TransformPoint(x, y))
        circle.SetEnd(self.TransformPoint(x, y + r))
        if filled:
            circle.SetFilled(True)
        self.module.Add(circle)

    def MyCmp(self, n1, n2):
        return -1 if n1 < n2 else 1 if n1 > n2 else 0

    def Arc(self, cx, cy, sx, sy, angle):
        """An arc about (cx, cy) from (sx, sy), through `angle` (an EDA_ANGLE, or tenths of a degree as older wizards pass)."""
        arc = self._shape(pcbnew.SHAPE_T_ARC)
        if not isinstance(angle, pcbnew.EDA_ANGLE):
            angle = pcbnew.EDA_ANGLE(float(angle) / 10.0, pcbnew.DEGREES_T)
        t = self.dc["transform"]
        if self.MyCmp(t[0], 0) != self.MyCmp(t[4], 0):          # a mirrored transform turns the arc the other way
            angle = -angle
        arc.SetCenter(self.TransformPoint(cx, cy))
        arc.SetStart(self.TransformPoint(sx, sy))
        arc.SetArcAngleAndEnd(angle, True)
        self.module.Add(arc)

    def HLine(self, x, y, l):
        self.Line(x, y, x + l, y)

    def VLine(self, x, y, l):
        self.Line(x, y, x, y + l)

    def Polyline(self, pts, mirrorX=None, mirrorY=None):
        def lines(pts):
            for i in range(len(pts) - 1):
                self.Line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])

        lines(pts)
        if mirrorX is not None and mirrorY is not None:
            self.TransformFlip(mirrorX, mirrorY, self.flipBoth)
        elif mirrorX is not None:
            self.TransformFlip(mirrorX, 0, self.flipX)
        elif mirrorY is not None:
            self.TransformFlip(0, mirrorY, self.flipY)
        else:
            return
        lines(pts)
        self.PopTransform()

    def _text(self, field, x, y, size, orientation_degree):
        field.SetPosition(self.TransformPoint(x, y))
        field.SetTextSize(pcbnew.VECTOR2I(int(size), int(size)))
        field.SetTextAngle(pcbnew.EDA_ANGLE(orientation_degree, pcbnew.DEGREES_T))

    def Reference(self, x, y, size, orientation_degree=0):
        self._text(self.module.Reference(), x, y, size, orientation_degree)

    def Value(self, x, y, size, orientation_degree=0):
        self._text(self.module.Value(), x, y, size, orientation_degree)
        self.module.Value().SetLayer(self.DefaultTextValueLayer())

    def Box(self, x, y, w, h):
        self.Polyline([[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2], [x - w / 2, y - h / 2]])

    def NotchedCircle(self, x, y, r, notch_w, notch_h, rotate=0):
        self.TransformTranslate(x, y)
        self.TransformRotationOrigin(rotate)
        angle_intercept = math.asin(notch_w / (2 * r))
        sx, sy = math.sin(angle_intercept) * r, -math.cos(angle_intercept) * r
        self.Arc(0, 0, sx, sy, pcbnew.EDA_ANGLE(math.pi * 2 - angle_intercept * 2, pcbnew.RADIANS_T))
        self.Polyline([[sx, sy], [sx, -r - notch_h], [-sx, -r - notch_h], [-sx, sy]])
        self.PopTransform(2)

    def NotchedBox(self, x, y, w, h, notchW, notchH, rotate=0):
        self.TransformRotation(x, y, rotate)
        self.Polyline([[0, 0], [notchW / 2, 0], [notchW / 2, notchH], [w / 2, notchH], [w / 2, h], [0, h]], mirrorX=0)
        self.PopTransform()
        self.TransformTranslate(x, y)
        self.PopTransform()

    def BoxWithDiagonalAtCorner(self, x, y, w, h, setback=pcbnew.FromMM(1.27), flip=flipNone):
        self.TransformFlip(x, y, flip, push=True)
        self.Polyline([[x - w / 2 + setback, y - h / 2], [x - w / 2, y - h / 2 + setback], [x - w / 2, y + h / 2], [x + w / 2, y + h / 2], [x + w / 2, y - h / 2],
                       [x - w / 2 + setback, y - h / 2]])
        self.PopTransform()

    def BoxWithOpenCorner(self, x, y, w, h, setback=pcbnew.FromMM(1.27), flip=flipNone):
        self.TransformTranslate(x, y)
        self.TransformFlipOrigin(flip)
        self.Polyline([[-w / 2, -h / 2 + setback], [-w / 2, +h / 2], [+w / 2, +h / 2], [+w / 2, -h / 2], [-w / 2 + setback, -h / 2]])
        self.PopTransform(num=2)

    def RoundedBox(self, x, y, w, h, rad):
        x_inner, y_inner = w - rad * 2, h - rad * 2
        x_left, y_top = x - w / 2, y - h / 2
        self.Line(x_left + rad, y_top, x_left + rad + x_inner, y_top)
        self.Line(x_left + rad, y_top + h, x_left + rad + x_inner, y_top + h)
        self.Line(x_left, y_top + rad, x_left, y_top + rad + y_inner)
        self.Line(x_left + w, y_top + rad, x_left + w, y_top + rad + y_inner)
        ninety = pcbnew.EDA_ANGLE(90, pcbnew.DEGREES_T)
        cx, cy = x - w / 2 + rad, y - h / 2 + rad
        self.Arc(cx, cy, x_left, cy, ninety)                    # upper left
        cx = x_left + w - rad
        self.Arc(cx, cy, cx, y_top, ninety)                     # upper right
        cy = y_top + h - rad
        self.Arc(cx, cy, x_left + w, cy, ninety)                # lower right
        cx = x_left + rad
        self.Arc(cx, cy, cx, y_top + h, ninety)                 # lower left

    def ChamferedBox(self, x, y, w, h, chamfer_x, chamfer_y):
        x_inner, y_inner = w - chamfer_x * 2, h - chamfer_y * 2
        x_left, y_top = x - w / 2, y - h / 2
        self.Polyline([[x_left + chamfer_x, y_top], [x_left + chamfer_x + x_inner, y_top], [x_left + w, y_top + chamfer_y], [x_left + w, y_top + chamfer_y + y_inner],
                       [x_left + chamfer_x + x_inner, y_top + h], [x_left + chamfer_x, y_top + h], [x_left, y_top + chamfer_y + y_inner], [x_left, y_top + chamfer_y],
                       [x_left + chamfer_x, y_top]])

    def MarkerArrow(self, x, y, direction=dirN, width=pcbnew.FromMM(1)):
        self.TransformTranslate(x, y)
        self.TransformRotationOrigin(direction)
        self.Polyline([[0, 0], [width / 2, width / 2], [-width / 2, width / 2], [0, 0]])
        self.PopTransform(2)
