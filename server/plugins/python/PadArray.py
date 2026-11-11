"""PadArray: KiCad's helper module for footprint wizards that place rows, grids and circles of pads."""

import math

import pcbnew


class PadMaker:
    """Template pads for an array."""

    def __init__(self, module):
        self.module = module

    def THPad(self, Vsize, Hsize, drill, shape=pcbnew.PAD_SHAPE_OVAL, rot_degree=0):
        pad = pcbnew.PAD(self.module)
        pad.SetSize(pcbnew.VECTOR2I(int(Hsize), int(Vsize)))
        pad.SetShape(shape)
        pad.SetAttribute(pcbnew.PAD_ATTRIB_PTH)
        pad.SetLayerSet(pad.PTHMask())
        pad.SetDrillSize(pcbnew.VECTOR2I(int(drill), int(drill)))
        pad.SetOrientation(pcbnew.EDA_ANGLE(rot_degree, pcbnew.DEGREES_T))
        return pad

    def THRoundPad(self, size, drill):
        return self.THPad(size, size, drill, shape=pcbnew.PAD_SHAPE_CIRCLE)

    def NPTHRoundPad(self, drill):
        pad = pcbnew.PAD(self.module)
        pad.SetSize(pcbnew.VECTOR2I(int(drill), int(drill)))
        pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
        pad.SetAttribute(pcbnew.PAD_ATTRIB_NPTH)
        pad.SetLayerSet(pad.UnplatedHoleMask())
        pad.SetDrillSize(pcbnew.VECTOR2I(int(drill), int(drill)))
        return pad

    def SMDPad(self, Vsize, Hsize, shape=pcbnew.PAD_SHAPE_RECT, rot_degree=0):
        pad = pcbnew.PAD(self.module)
        pad.SetSize(pcbnew.VECTOR2I(int(Hsize), int(Vsize)))
        pad.SetShape(shape)
        pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
        pad.SetLayerSet(pad.SMDMask())
        pad.SetOrientation(pcbnew.EDA_ANGLE(rot_degree, pcbnew.DEGREES_T))
        return pad

    def SMTRoundPad(self, size):
        return self.SMDPad(size, size, shape=pcbnew.PAD_SHAPE_CIRCLE)


class PadArray:
    """The base of the arrays: a template pad, an optional different first pad, and how pads are numbered."""

    def __init__(self, pad):
        self.firstPadNum = 1
        self.pinNames = None
        self.firstPad = None
        self.pad = pad

    def SetPinNames(self, pinNames):
        self.pinNames = pinNames

    def SetFirstPadType(self, firstPad):
        self.firstPad = firstPad

    def SetFirstPadInArray(self, fpNum):
        self.firstPadNum = fpNum

    def AddPad(self, pad):
        self.pad.GetParent().Add(pad)

    def GetPad(self, is_first_pad, pos):
        pad = (self.firstPad if self.firstPad and is_first_pad else self.pad).Duplicate()
        pad.SetPosition(pos)
        return pad

    def GetName(self, *args, **kwargs):
        if self.pinNames is None:
            return self.NamingFunction(*args, **kwargs)
        return self.pinNames

    def NamingFunction(self, *args, **kwargs):
        raise NotImplementedError


class PadGridArray(PadArray):
    def __init__(self, pad, nx, ny, px, py, centre=None):
        super().__init__(pad)
        self.nx, self.ny, self.px, self.py = int(nx), int(ny), px, py
        self.centre = centre if centre is not None else pcbnew.VECTOR2I(0, 0)

    def AlphaNameFromNumber(self, n, aIndex=1, alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ"):
        div, mod = divmod(n - aIndex, len(alphabet))
        alpha = alphabet[mod]
        if div > 0:
            return self.AlphaNameFromNumber(div, aIndex, alphabet) + alpha
        return alpha

    def NamingFunction(self, x, y):
        return self.firstPadNum + (self.nx * y + x)

    def AddPadsToModule(self, dc):
        pin1posX = self.centre.x - self.px * (self.nx - 1) / 2
        pin1posY = self.centre.y - self.py * (self.ny - 1) / 2
        for x in range(self.nx):
            posX = pin1posX + self.px * x
            for y in range(self.ny):
                posY = pin1posY + self.py * y
                pad = self.GetPad(x == 0 and y == 0, dc.TransformPoint(posX, posY))
                pad.SetName(str(self.GetName(x, y)))
                self.AddPad(pad)


class EPADGridArray(PadGridArray):
    def NamingFunction(self, nx, ny):
        return self.firstPadNum


class PadZGridArray(PadArray):
    def __init__(self, pad, pad_count, line_count, line_pitch, pad_pitch, centre=None):
        super().__init__(pad)
        self.pad_count, self.line_count = int(pad_count), int(line_count)
        self.line_pitch, self.pad_pitch = line_pitch, pad_pitch
        self.centre = centre if centre is not None else pcbnew.VECTOR2I(0, 0)

    def NamingFunction(self, pad_pos):
        return self.firstPadNum + pad_pos

    def AddPadsToModule(self, dc):
        pin1posX = self.centre.x - self.pad_pitch * (self.pad_count - 1) / 2
        pin1posY = self.centre.y + self.line_pitch * (self.line_count - 1) / 2
        line = 0
        for padnum in range(self.pad_count):
            posX = pin1posX + self.pad_pitch * padnum
            posY = pin1posY - self.line_pitch * line
            pad = self.GetPad(padnum == 0, dc.TransformPoint(posX, posY))
            pad.SetName(str(self.GetName(padnum)))
            self.AddPad(pad)
            line += 1
            if line >= self.line_count:
                line = 0


class PadCircleArray(PadArray):
    def __init__(self, pad, n, r, angle_offset=0, centre=None, clockwise=True, padRotationEnable=False, padRotationOffset=0):
        super().__init__(pad)
        self.n, self.r, self.angle_offset = int(n), r, angle_offset
        self.centre = centre if centre is not None else pcbnew.VECTOR2I(0, 0)
        self.clockwise, self.padRotationEnable, self.padRotationOffset = clockwise, padRotationEnable, padRotationOffset

    def NamingFunction(self, n):
        return str(self.firstPadNum + n)

    def AddPadsToModule(self, dc):
        for pin in range(self.n):
            angle = self.angle_offset + (360 / self.n) * pin
            if not self.clockwise:
                angle = -angle
            pos_x = math.sin(angle * math.pi / 180) * self.r
            pos_y = -math.cos(angle * math.pi / 180) * self.r
            pad = self.GetPad(False, dc.TransformPoint(pos_x, pos_y))
            pad_angle = self.padRotationOffset
            if self.padRotationEnable:
                pad_angle -= angle
            pad.SetOrientation(pcbnew.EDA_ANGLE(pad_angle, pcbnew.DEGREES_T))
            pad.SetName(str(self.GetName(pin)))
            self.AddPad(pad)


class PadLineArray(PadGridArray):
    def __init__(self, pad, n, pitch, isVertical, centre=None):
        if isVertical:
            super().__init__(pad, 1, n, 0, pitch, centre)
        else:
            super().__init__(pad, n, 1, pitch, 0, centre)


class PadCustomArray(PadArray):
    """Pads at the positions of `array`, a list of (x, y)."""

    def __init__(self, pad, array):
        super().__init__(pad)
        self.array = array

    def NamingFunction(self, n):
        return str(self.firstPadNum + n)

    def AddPadsToModule(self, dc):
        for i, (x, y) in enumerate(self.array):
            pad = self.GetPad(i == 0, dc.TransformPoint(x, y))
            pad.SetName(str(self.GetName(i)))
            self.AddPad(pad)
