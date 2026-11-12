"""Breadboard Builder: its simulation is ngspice.  The plugin's own simulation code is run here on a circuit written
as it writes them (a divider between its binding posts): through libngspice, which it tries first, and through the
ngspice program, its fallback.  The voltages it reads back must be the divider's, and a transient run must give a
waveform that follows the RC time constant."""
import math
import sys

DC = """* Breadboard SPICE netlist

R1  vcc  mid  1k
R2  mid  0  3k
V_bb_V1  vcc  0  DC 10

.op
.end
"""

TRAN = """* Breadboard SPICE netlist

R1  vcc  mid  1k
C1  mid  0  1u
V_bb_V1  vcc  0  PULSE(0 5 0 1n 1n 1 2)

.tran 50u 5m
.end
"""


def _module():
    for name, mod in list(sys.modules.items()):
        if name.endswith("model.simulation") and hasattr(mod, "_run_ngspice"):
            return mod
    raise AssertionError("the plugin's simulation module is not loaded")


def after_run(name):
    sim = _module()
    lib = sim._NgSpiceLib.get()
    assert lib is not None, "the plugin did not find libngspice"
    out, err, _warn = sim._run_ngspice(DC)
    assert err is None, f"its libngspice run failed: {err}\n{out[-400:]}"
    volts, amps = sim._parse_output(out)
    if not volts:
        volts, amps = lib._read_dc_vectors()
    assert abs(volts.get("mid", 0) - 7.5) < 1e-6 and abs(volts.get("vcc", 0) - 10) < 1e-6, f"wrong divider voltages: {volts}"
    assert any(abs(v + 2.5e-3) < 1e-9 for v in amps.values()), f"wrong source current: {amps}"

    out2, err2, _w = sim._run_ngspice_subprocess(DC)
    assert err2 is None, f"its ngspice program run failed: {err2}\n{out2[-400:]}"
    volts2, amps2 = sim._parse_output(out2)
    assert abs(volts2.get("mid", 0) - 7.5) < 1e-6, f"the program's output table was not read: {volts2}\n{out2[-600:]}"

    out3, err3, _w = sim._run_ngspice(TRAN)
    assert err3 is None, f"its transient run failed: {err3}\n{out3[-400:]}"
    traces, diag = lib._read_tran_vectors({"mid": "mid", "vcc": "vcc"})
    assert traces, f"no transient traces: {diag}"
    tr = traces.get("mid") or next(iter(traces.values()))
    times, values = list(tr.times), list(tr.values)
    # one time constant (1 ms) after the step the capacitor is at 5 V x (1 - 1/e)
    k = min(range(len(times)), key=lambda i: abs(times[i] - 1e-3))
    want = 5 * (1 - math.exp(-times[k] / 1e-3))
    assert abs(values[k] - want) < 0.05, f"the RC step is off: {values[k]:.4f} V at {times[k] * 1e3:.3f} ms, expected {want:.4f} V"
    return f"divider {volts['mid']:.3f} V by library and {volts2['mid']:.3f} V by program; RC step {values[k]:.3f} V at {times[k] * 1e3:.2f} ms ({len(times)} points)"
