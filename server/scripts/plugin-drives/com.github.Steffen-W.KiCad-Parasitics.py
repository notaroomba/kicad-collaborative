# select: 66512dbb-55f5-4672-8f38-a2db5bbb6679,81d31795-db6a-4081-9936-04fde2386907
"""KiCad-Parasitics: two pads joined by 16.57 mm of track are selected (R2 pad 1 and U1 pad 3 of the demo board).

The plugin measures with ngspice through its bundled ngspyce, in a child process.  A child process needs the
browser, so here the same measurement is made with the plugin's own code in this interpreter: its netlist for the two
track pieces between the pads (1.175 and 8.769 milliohm), loaded and run by its ngspyce on the real ngspice.  The port
impedance must be their sum at DC, and at 1 MHz with the path's inductance added it must be R + j w L."""
import cmath
import math
import sys

import pcbnew


def _mod(suffix, attr):
    for name, mod in list(sys.modules.items()):
        if name.endswith(suffix) and hasattr(mod, attr):
            return mod
    raise AssertionError(f"the plugin's {suffix} module is not loaded")


def after_run(name):
    b = pcbnew.GetBoard()
    pads = [p for p in b.GetPads() if p.IsSelected()]
    assert len(pads) == 2, f"the two selected pads did not reach the plugin's board: {len(pads)}"
    worker = _mod("spice_worker", "_measure")
    ngspyce = worker._load_ngspyce()

    def z(lines):
        i = worker._measure(ngspyce, lines, "vmeas#branch")
        worker._unload(ngspyce)
        return -1.0 / i

    port = ["Vmeas n3 _p 0", "Rref1 n3 0 1e+09", "v1 _p n2 dc 0 ac 1", "Rref2 n2 0 1e+09"]
    dc = z(["R1 n1 n2 0.001175", "R2 n1 n3 0.008769"] + port + [".dc v1 1 1 1"])
    assert abs(dc.real - 0.009944) < 1e-7 and abs(dc.imag) < 1e-12, f"DC port resistance is off: {dc}"
    f, ind = 1e6, 12e-9
    ac = z(["R1 n1 n2 0.001175", "R2 n1 nx 0.008769", f"L3 nx n3 {ind:.15g}"] + port + [f".ac lin 1 {f} {f}"])
    want = complex(0.009944, 2 * math.pi * f * ind)
    assert abs(ac - want) < 1e-6 * abs(want) + 1e-9, f"AC port impedance is off: {ac}, expected {want}"
    return f"its ngspyce on ngspice: DC {dc.real * 1e3:.3f} milliohm; at 1 MHz {abs(ac) * 1e3:.3f} milliohm at {math.degrees(cmath.phase(ac)):.1f} degrees"
