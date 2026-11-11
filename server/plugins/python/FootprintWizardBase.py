# FootprintWizardBase — KiCad's helper module for footprint wizards.  The web editor has no
# footprint editor yet, so a wizard is not offered; the module exists so a plugin that carries
# a wizard next to its board actions still loads.
import pcbnew


class FootprintWizard(pcbnew.FootprintWizardPlugin):
    def __init__(self):
        pcbnew.FootprintWizardPlugin.__init__(self)

    def AddParam(self, *a, **k):
        pass

    def GenerateParameterList(self):
        pass

    def CheckParameters(self):
        pass

    def BuildThisFootprint(self):
        pass

    def GetValue(self):
        return ""

    def GetReferencePrefix(self):
        return "REF"


class FootprintWizardDrawingAids:
    def __init__(self, module=None):
        self.module = module

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


uMM = uMils = uFloat = uInteger = uBool = uRadians = uDegrees = uPercent = uString = 0
