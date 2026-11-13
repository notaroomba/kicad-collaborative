"""The physics of a layout as calls: what the copper must do for the board to work.

`board.review()` (rules.py) also runs the layout physics checks of the design engine (web/ai/review-physics.ts):
antennas, RF feeds, return paths, differential pairs and memory buses, crystals, switching converters, thermal pads,
amplifier inputs, isolation and spacing for the voltage.  The calls here put in the copper those checks ask for:

    board.plan()                    BEFORE placing: what sits beside what, what goes on an edge, widths and order for routing
    board.prepare()                 after placing, before routing: antenna keep-outs and their ground vias
    board.finish()                  after routing: RF fences, thermal vias, stitching
    board.antenna("AE1")            keep-out under and around an antenna on every layer, ground vias along its edge
    board.fence_net("RF_ANT")       ground vias down both sides of a routed net (board.fence(path) does a free path)
    board.thermal_vias("U1")        the via array of an exposed pad
    board.stackup(fab="jlcpcb", layers=4)   the physical stackup of a fabricator's standard build (stackups.py)

`kh.calc` has the sums a layout needs before it is drawn: wavelength and via pitch, the length at which a track is a
transmission line, track width and via count for a current (IPC-2221), conductor spacing for a voltage (IPC-2221
table 6-1), microstrip and stripline impedance, I2C pull-ups, and the routing rules of the common interfaces.
The reference for all of it is server/docs/pcb-design-rules.md (get_design_guide topic "layout").

The methods are attached to Board when the package is imported.
"""
from __future__ import annotations

import math

from . import rules as _rules
from .transport import HarnessError


def _r(v: float) -> float:
    return round(v, 4)


def _plan(self, **plan) -> dict:
    r = self._call("review_design", plan={k: v for k, v in plan.items() if v is not None})
    if r.get("error"):
        raise HarnessError(r["error"])
    return r


def _has_zones(self) -> bool:
    try:
        return bool(self.fill().get("zones"))
    except HarnessError:
        return False


# ---------------------------------------------------------------- review

def _board_review(self, level: str | None = None, rule: str | None = None, limit: int = 40) -> dict:
    """Check the board against the layout checklist and the layout physics (antenna keep-out and ground stitching,
    RF feed, return paths under fast nets, pairs and memory buses, crystal, converter loops, thermal pads, amplifier
    inputs, isolation gaps, spacing for the voltage).  The zones are filled first, because the ground checks read the
    real copper.  Returns what Schematic.review returns."""
    try:
        self.fill()
    except HarnessError:
        pass
    return _rules._review(self, level=level, rule=rule, limit=limit)


# ---------------------------------------------------------------- copper the checks ask for

def _antenna(self, ref: str | None = None, clearance: float | None = None, pitch: float = 2.0, kind: str | None = None,
             size: float | None = None, drill: float | None = None) -> dict:
    """Give an antenna what it needs from the board: a keep-out over its clear area on every copper layer (no pour, no
    track, no via under or beside it) and a row of ground vias, `pitch` mm apart, along the edge of the ground that
    faces it, so the pours of all layers act as one ground instead of radiating against each other.

    ref: the antenna (every part with reference AE.. or ANT.., or an antenna footprint, when left out).
    clearance: how far the clear area reaches beyond the part's courtyard (2 mm by default; take the figure from the
    antenna's datasheet, which is binding).  Where the board edge is within 3 mm the area runs out to the edge.
    kind="patch": a patch antenna (GPS) is the opposite case: it needs unbroken ground under it, so no keep-out is
    added and only the ground around it is stitched.
    Call it after the ground zones exist and before routing, or after routing to add what is missing; it refills
    the zones.  Ground vias already standing in the clear area are taken out; tracks and vias of other nets there are
    listed under "in_the_way" for you to move (board.unroute, then route again: the router keeps vias out of the area).
    Returns {ref: {"keepout": box or None, "vias": n, "no_room": n, "removed": n, "in_the_way": [...], "edge_distance": mm}}."""
    self.flush()
    filled = _has_zones(self)
    plan = _plan(self, what="antenna", ref=ref, clearance=clearance, pitch=pitch, size=size, kind=kind)
    out = {}
    for a in plan["antennas"]:
        box = None
        if not a.get("patch") and not a["has_keepout"]:
            box = a["box"]
            self.keepout(box, tracks=False, name=f"{a['ref']} antenna keep-out")      # the feed itself must get in
            self.flush()
        for vid in a.get("remove") or []:      # ground vias that stood where the clear area now is
            self._edit({"op": "remove", "id": vid})
        self.flush()
        got = _rules._vias_checked(self, plan["net"], [tuple(p) for p in a["vias"]], size, drill) if a["vias"] else {"vias": 0, "removed": 0}
        out[a["ref"]] = {"keepout": box, "vias": got["vias"], "no_room": a["no_room"] + got.get("removed", 0), "edge_distance": a["edge_distance"], "frequency_ghz": a.get("frequency_ghz"),
                         "removed": len(a.get("remove") or []), "in_the_way": a.get("blocked") or []}
        self.project.note(f"board: antenna {a['ref']}: {'keep-out added, ' if box else ''}{got['vias']} ground vias along its edge")
    if filled:
        try:
            self.fill()
        except HarnessError:
            pass
    self._geom = None
    return out


def _fence_net(self, net: str, spacing: float = 2.0, offset: float | None = None, size: float | None = None, drill: float | None = None) -> dict:
    """Ground vias down both sides of a routed net, `spacing` mm apart: the fence of an RF feed or a clock.  Each via
    stands `offset` mm from the track's centre line (by default just clear of it), only where ground is poured on two
    layers and nothing is in the way.  board.fence(path, ...) fences a path you choose instead of a net.
    Returns {"vias", "no_room", "spacing"}."""
    self.flush()
    _has_zones(self)
    plan = _plan(self, what="fence", net=self._net(net), spacing=spacing, offset=offset, size=size)
    got = _rules._vias_checked(self, plan["net"], [tuple(p) for p in plan["vias"]], size, drill) if plan["vias"] else {"vias": 0, "removed": 0}
    out = {"vias": got["vias"], "no_room": plan["no_room"] + got.get("removed", 0), "spacing": plan["spacing"]}
    self.project.note(f"board: fence of {out['vias']} ground vias along {net}")
    return out


def _thermal_vias(self, ref: str | None = None, pitch: float = 1.2, size: float = 0.6, drill: float = 0.3) -> dict:
    """An array of vias in a part's exposed pad (every exposed pad on the board when no part is named), on the pad's
    own net, `pitch` mm apart: the heat path into the planes and, on most parts, the main ground.  The drill stays at
    0.3 mm so the vias do not wick the solder away (TI SLMA002).  Returns {ref: {"pad", "net", "vias", "had"}}."""
    self.flush()
    plan = _plan(self, what="thermal", ref=ref, pitch=pitch, size=size)
    out = {}
    for p in plan["pads"]:
        if not p["net"]:
            out[p["ref"]] = {"pad": p["pad"], "net": "", "vias": 0, "had": p["had"], "note": "the pad is on no net"}
            continue
        got = _rules._vias_checked(self, p["net"], [tuple(q) for q in p["vias"]], size, drill) if p["vias"] else {"vias": 0}
        out[p["ref"]] = {"pad": p["pad"], "net": p["net"], "vias": got["vias"], "had": p["had"]}
    if out:
        self.project.note("board: thermal vias " + ", ".join(f"{k} +{v['vias']}" for k, v in out.items()))
    return out


# ---------------------------------------------------------------- before and after: plan, prepare, finish

def _layout_plan(self, edge: str = "top") -> dict:
    """Work the layout out from the netlist BEFORE anything is placed or routed.  Returns
    {"place": {"near": {ref: ref}, "edges": {ref: side}}, "why": {ref: reason}, "apart": [[ref, ref]],
     "route": {"widths": {net: mm}, "kinds": {net: kind}, "order": [nets]}, "pairs": [...], "notes": [...], "steps": [...]}.

    place: what must sit beside what (each decoupling capacitor at its IC, the crystal and its capacitors at the
    oscillator pins, a converter's inductor and capacitors round the converter, the matching network at the antenna,
    ESD parts at their connector, feedback parts at the amplifier) and what goes on an edge (the antenna, on `edge`).
    Hand it to autoplace: board.autoplace(near=plan["place"]["near"], edges={**plan["place"]["edges"], "J1": "left"}).
    apart: pairs to keep far from each other (the converter's inductor and the antenna or the crystal).
    route: hand it to board.route(**plan["route"]): RF nets at their 50 ohm width, supplies wide, pairs and crystal first.
    notes say what the plan cannot do for you (a stackup that cannot give 50 ohm, a barrier to keep clear); steps is
    the order of the calls.  Call it after board.sync()."""
    self.flush()
    plan = _plan(self, what="layout", edge=edge)
    # the board to build it on, chosen before anything is placed: material, layer count and finish for what is on it
    try:
        from . import stackups as _st
        kinds = set((plan.get("route") or {}).get("kinds", {}).values())
        want = _st.choose(ghz=plan.get("radio_ghz") or None, radio=bool(plan.get("radio_ghz")) or "rf" in kinds, fast=bool(plan.get("pairs")) or "fast" in kinds, fine_pitch=plan.get("fine_pitch"), bga=bool(plan.get("bga")))
        have = _plan(self, what="stackup")
        plan["stackup"] = {"recommended": want["stackup"], "why": want["why"], "now": {"copper_layers": len(have.get("copper_layers") or []), "thickness": have.get("thickness"), "assumed": have.get("assumed"), "flex": have.get("flex")}}
        if not have.get("flex") and want["layers"] > len(have.get("copper_layers") or []):
            plan.setdefault("notes", []).insert(0, f"The board has {len(have.get('copper_layers') or [])} copper layers; this design wants {want['layers']}. " + " ".join(want["why"][:1]) + f" Set it first: board.stackup(fab=\"jlcpcb\", layers={want['layers']}).")
        elif have.get("assumed"):
            plan.setdefault("notes", []).insert(0, "The board has no physical stackup yet, so impedance widths are estimates. Set the fabricator's: board.stackup(fab=\"jlcpcb\", layers=...).")
    except HarnessError:
        pass
    self._layout = plan
    self.project.note(f"board: layout plan: {len(plan['place']['near'])} parts tied to their neighbours, {len(plan['place']['edges'])} on an edge, {len(plan['notes'])} notes")
    return plan


def _prepare(self) -> dict:
    """After placement and the ground zones, before routing: give every antenna its keep-out and the ground vias along
    its edge, so the router never lays copper there.  Returns {"antennas": {...}}."""
    out = {"antennas": {}}
    try:
        out["antennas"] = self.antenna()
    except HarnessError as e:
        if "no antenna" not in str(e):
            raise
    return out


def _finish(self, stitch: float | None = 10.0) -> dict:
    """After routing: what the copper still owes the physics.  Antenna edges get the vias the routing left room for,
    every routed RF net gets its fence, exposed pads get their via arrays, the ground pours are stitched (every
    `stitch` mm; None leaves that out) and the zones are filled again.  Returns what each step added; follow it with
    board.review()."""
    out: dict = {"antennas": {}, "fences": {}, "thermal": {}}
    try:
        out["antennas"] = self.antenna()
    except HarnessError as e:
        if "no antenna" not in str(e):
            raise
    plan = getattr(self, "_layout", None) or _plan(self, what="layout")
    for net, kind in (plan.get("route", {}).get("kinds") or {}).items():
        if kind != "rf":
            continue
        try:
            out["fences"][net] = self.fence_net(net, spacing=max(1.0, min(2.0, (plan.get("radio_ghz") and calc.via_pitch(plan["radio_ghz"] * 1e9)) or 2.0)))["vias"]
        except HarnessError:
            out["fences"][net] = 0      # not routed
    try:
        out["thermal"] = {k: v["vias"] for k, v in self.thermal_vias().items()}
    except HarnessError:
        pass
    try:      # every ground pad its own via to the plane, so none hangs on a piece of pour alone
        out["ground_pads"] = self.ground_pads()["vias"]
    except HarnessError:
        out["ground_pads"] = 0
    if stitch:
        try:
            out["stitching"] = self.stitch(spacing=stitch)["vias"]
        except HarnessError:
            out["stitching"] = 0
    try:
        self.fill()
    except HarnessError:
        pass
    return out


# ---------------------------------------------------------------- the sums

C_MM_PER_NS = 299.792458


class calc:      # noqa: N801  (a namespace: kh.calc.wavelength(...))
    """The sums of board design.  Lengths in mm, frequencies in Hz, currents in A, voltages in V, temperatures in K."""

    @staticmethod
    def wavelength(freq_hz: float, er: float = 4.4) -> float:
        """The wavelength in mm of a signal inside a dielectric (FR-4 by default; er=1 for air)."""
        return C_MM_PER_NS * 1e9 / freq_hz / math.sqrt(er)

    @staticmethod
    def via_pitch(freq_hz: float, er: float = 4.4, fraction: float = 20) -> float:
        """The largest gap in mm between stitching or fence vias that still looks like a wall at this frequency:
        a twentieth of a wavelength (a tenth is the outer limit)."""
        return calc.wavelength(freq_hz, er) / fraction

    @staticmethod
    def quarter_wave(freq_hz: float, er_eff: float = 1.0) -> float:
        """The length in mm of a quarter-wave monopole (in air by default; a trace antenna on FR-4 is shorter by
        about the square root of its effective permittivity, 1.5 to 2)."""
        return C_MM_PER_NS * 1e9 / freq_hz / math.sqrt(er_eff) / 4

    @staticmethod
    def critical_length(rise_ns: float, er_eff: float = 3.3, fraction: float = 6) -> float:
        """The track length in mm above which a signal with this rise time must be treated as a transmission line
        (terminated, impedance controlled): a sixth of the edge's length on the board (Johnson and Graham)."""
        return rise_ns * C_MM_PER_NS / math.sqrt(er_eff) / fraction

    @staticmethod
    def knee_frequency(rise_ns: float) -> float:
        """The frequency in Hz below which most of a digital edge's energy lies: 0.5 / rise time."""
        return 0.5 / (rise_ns * 1e-9)

    @staticmethod
    def track_width(amps: float, rise: float = 10.0, oz: float = 1.0, internal: bool = False) -> float:
        """IPC-2221: the track width in mm that carries `amps` with a temperature rise of `rise` kelvin in copper of
        `oz` ounces (35 um per ounce).  Inner layers need about 2.6 times the width of outer ones."""
        k = 0.024 if internal else 0.048
        area_mil2 = (amps / (k * rise ** 0.44)) ** (1 / 0.725)
        return area_mil2 / (oz * 1.378) * 0.0254

    @staticmethod
    def track_current(width: float, rise: float = 10.0, oz: float = 1.0, internal: bool = False) -> float:
        """IPC-2221: the current in A a track of this width carries for the temperature rise."""
        k = 0.024 if internal else 0.048
        return k * rise ** 0.44 * (width / 0.0254 * oz * 1.378) ** 0.725

    @staticmethod
    def via_current(drill: float = 0.3, plating: float = 0.025, rise: float = 10.0) -> float:
        """The current in A one plated via carries (IPC-2221 on the barrel's copper cross section).  A 0.3 mm via with
        25 um plating is good for about 1 A at 10 K; use several for a supply."""
        area_mil2 = math.pi * (drill + plating) * plating / (0.0254 ** 2)
        return 0.048 * rise ** 0.44 * area_mil2 ** 0.725

    @staticmethod
    def vias_for(amps: float, drill: float = 0.3, plating: float = 0.025, rise: float = 10.0) -> int:
        """How many vias a current needs, with one to spare."""
        return int(math.ceil(amps / calc.via_current(drill, plating, rise))) + 1

    @staticmethod
    def spacing(volts: float, where: str = "outer") -> float:
        """IPC-2221 table 6-1: the least spacing in mm between conductors with `volts` (DC or AC peak) between them.
        where: "outer" (under solder mask, column B4), "bare" (no mask, B2), "inner" (B1), "leads" (component leads
        under coating, A6) or "bare leads" (A7).  Mains needs the larger distances of the product's safety standard."""
        col = {"outer": "B4", "bare": "B2", "inner": "B1", "leads": "A6", "bare leads": "A7"}.get(where, where)
        bands = [15, 30, 50, 100, 150, 170, 250, 300, 500]
        table = {"B1": [0.05, 0.05, 0.1, 0.1, 0.2, 0.2, 0.2, 0.2, 0.25], "B2": [0.1, 0.1, 0.64, 0.64, 0.64, 1.25, 1.25, 1.25, 2.5],
                 "B4": [0.075, 0.075, 0.3, 0.3, 0.8, 0.8, 0.8, 0.8, 1.6], "A6": [0.13, 0.13, 0.13, 0.13, 0.4, 0.4, 0.4, 0.4, 0.8],
                 "A7": [0.13, 0.25, 0.4, 0.5, 0.8, 0.8, 0.8, 0.8, 1.5]}
        slope = {"B1": 0.0025, "B2": 0.005, "B4": 0.00305, "A6": 0.00305, "A7": 0.00305}
        if col not in table:
            raise HarnessError('where is "outer", "bare", "inner", "leads" or "bare leads".')
        v = abs(volts)
        for b, s in zip(bands, table[col]):
            if v <= b:
                return s
        return round(table[col][-1] + (v - 500) * slope[col], 3)

    @staticmethod
    def microstrip(width: float, height: float, er: float = 4.4, copper: float = 0.035) -> float:
        """Impedance in ohm of a track on an outer layer, `height` mm above its plane (Hammerstad, with Wheeler's
        thickness correction; within a few percent for 0.1 < w/h < 3)."""
        w, h, t = width, height, copper
        we = w + t / math.pi * (1 + math.log(2 * h / t if w / h > 1 / (2 * math.pi) else 4 * math.pi * w / t)) if t > 0 else w
        u = we / h
        ee = (er + 1) / 2 + (er - 1) / 2 * (1 / math.sqrt(1 + 12 / u) + (0.04 * (1 - u) ** 2 if u < 1 else 0))
        return 60 / math.sqrt(ee) * math.log(8 / u + u / 4) if u <= 1 else 120 * math.pi / (math.sqrt(ee) * (u + 1.393 + 0.667 * math.log(u + 1.444)))

    @staticmethod
    def stripline(width: float, spacing: float, er: float = 4.4, copper: float = 0.035) -> float:
        """Impedance in ohm of a track on an inner layer centred between two planes `spacing` mm apart (IPC-2141)."""
        return 60 / math.sqrt(er) * math.log(4 * spacing / (0.67 * math.pi * (0.8 * width + copper)))

    @staticmethod
    def width_for(ohms: float, height: float, er: float = 4.4, copper: float = 0.035, inner_spacing: float | None = None) -> float | None:
        """The track width in mm that gives an impedance: a microstrip `height` above its plane, or with
        inner_spacing a stripline between planes that far apart.  None when no width from 0.05 to 8 mm does."""
        f = (lambda w: calc.stripline(w, inner_spacing, er, copper)) if inner_spacing else (lambda w: calc.microstrip(w, height, er, copper))
        lo, hi = 0.05, 8.0
        if f(lo) < ohms or f(hi) > ohms:
            return None
        for _ in range(60):
            m = (lo + hi) / 2
            lo, hi = (m, hi) if f(m) > ohms else (lo, m)
        return round((lo + hi) / 2, 3)

    @staticmethod
    def pair(width: float, gap: float, height: float, er: float = 4.4, copper: float = 0.035) -> float:
        """Differential impedance in ohm of an edge-coupled pair on an outer layer (IPC-2141 coupling factor)."""
        return 2 * calc.microstrip(width, height, er, copper) * (1 - 0.48 * math.exp(-0.96 * gap / height))

    @staticmethod
    def i2c_pullup(volts: float = 3.3, bus_pf: float = 100, speed_khz: int = 400) -> dict:
        """The range of I2C pull-up resistors in ohm for a supply, a bus capacitance and a speed: the least keeps the
        sink current at 3 mA (20 mA above 400 kHz), the most meets the rise time (1000, 300, 120 ns)."""
        rise = 1000e-9 if speed_khz <= 100 else 300e-9 if speed_khz <= 400 else 120e-9
        sink = 0.003 if speed_khz <= 400 else 0.02
        lo, hi = (volts - 0.4) / sink, rise / (0.8473 * bus_pf * 1e-12)
        return {"min": round(lo), "max": round(hi), "use": round(min(hi, max(lo * 1.5, hi / 2)), -2)}

    @staticmethod
    def decoupling_resonance(farads: float, nh: float = 1.0) -> float:
        """The frequency in Hz at which a capacitor and its mounting inductance (in nH: about 0.5 for an 0402 with
        vias in the pads' shadow, 1 to 2 for tracks to vias) resonate; above it the capacitor is an inductor."""
        return 1 / (2 * math.pi * math.sqrt(nh * 1e-9 * farads))

    @staticmethod
    def thermal_rise(watts: float, theta_ja: float) -> float:
        """Temperature rise in K of a part that dissipates `watts` with a junction-to-ambient resistance in K/W."""
        return watts * theta_ja

    @staticmethod
    def bend_radius(thickness: float, layers: int = 2, dynamic: bool = False) -> float:
        """The tightest radius in mm for a flex board: 6 x thickness for one layer, 10 x for more, bent once;
        15 x when it flexes in use."""
        from .stackups import bend_radius as _b
        return _b(thickness, layers, dynamic)

    @staticmethod
    def interface(name: str | None = None):
        """The routing rules of an interface: {"impedance", "pair_impedance", "skew_mm", "bus_skew_mm", "max_mm",
        "max_vias", "notes"}.  Names: usb2, usb3, hdmi, displayport, ethernet, pcie, sata, mipi, lvds, can, rs485,
        sdram, ddr1, ddr2, ddr3, ddr4, ddr5, lpddr4, emmc, sd, qspi, spi, i2c, i2s, jtag, rf.  Without a name: the list of names."""
        if name is None:
            return sorted(INTERFACES)
        key = name.lower().replace("-", "").replace("_", "").replace(" ", "").replace(".", "")
        key = _ALIAS.get(key, key)
        if key not in INTERFACES:
            raise HarnessError(f"No rules for {name}. Known: {', '.join(sorted(INTERFACES))}.")
        return dict(INTERFACES[key])


def _i(z=None, zd=None, skew=None, bus=None, mx=None, vias=None, notes=""):
    return {"impedance": z, "pair_impedance": zd, "skew_mm": skew, "bus_skew_mm": bus, "max_mm": mx, "max_vias": vias, "notes": notes}


#: The routing rules of the common interfaces.  The engine's table (review-physics.ts INTERFACES) has the same
#: figures and tests/test_physics.py holds the two together.
INTERFACES = {
    "usb2": _i(45, 90, 1.27, None, 300, 4, "D+ and D- side by side on one layer over unbroken ground; no stubs, no test points; ESD part at the connector; 90 ohm matters above about 50 mm, so on a small board keep the pair short and coupled."),
    "usb3": _i(45, 90, 0.13, None, 140, 2, "SuperSpeed pairs: 100 nF (220 nF for 10 Gbit) AC coupling on each TX track, placed together near the connector; ground vias beside every signal via; clear the plane under the capacitor and connector pads; keep away from the 2.4 GHz antenna (its noise sits at 2.5 GHz)."),
    "hdmi": _i(50, 100, 0.13, 2.5, 100, 2, "Four TMDS pairs, pairs matched to each other within the bus skew; ESD at the connector with flow-through routing; DDC pulled up to 5 V; no stubs."),
    "displayport": _i(50, 100, 0.13, 2.5, 150, 2, "100 nF AC coupling on the main link lanes at the source; AUX pair with its bias resistors."),
    "ethernet": _i(50, 100, 1.27, 2.5, 100, 2, "PHY to magnetics pairs short and symmetric; no copper on any layer under the magnetics between the PHY side and the cable side (the 1.5 kV isolation barrier); Bob Smith termination (75 ohm and 1 nF 2 kV) to chassis; 49.9 ohm terminations at the PHY where its datasheet asks; 25 MHz crystal rules apply."),
    "pcie": _i(42.5, 85, 0.13, None, 250, 2, "85 ohm pairs (100 ohm for Gen1 and Gen2); 100 nF or 220 nF AC coupling on TX; REFCLK is a 100 ohm pair; lanes need not match each other; back-drill or avoid via stubs above 5 Gbit."),
    "sata": _i(50, 100, 0.13, None, 140, 2, "10 nF AC coupling on all four tracks near the connector."),
    "mipi": _i(50, 100, 0.13, 1.0, 250, 2, "CSI-2 and DSI D-PHY: each lane a 100 ohm pair, data lanes matched to the clock lane; no stubs, no test points; keep the flex connector's ground pins beside each pair."),
    "lvds": _i(50, 100, 0.25, 2.5, 300, 2, "100 ohm termination across the pair at the receiver, right at its pins."),
    "can": _i(None, 120, None, None, None, None, "120 ohm across CANH and CANL at each end of the bus only (two 60 ohm with 4.7 nF from the middle to ground is better); common mode choke and TVS at the connector; stubs under 0.3 m at 1 Mbit."),
    "rs485": _i(None, 120, None, None, None, None, "120 ohm at each end of the cable, bias resistors at one place, TVS and series resistance at the connector; isolate the ground on long runs."),
    "sdram": _i(50, None, None, 10.0, 150, 2, "Single data rate SDRAM: every signal matched loosely to the clock, a series resistor (22 to 33 ohm) on the clock and on long lines at the driver, the clock longest or equal, over unbroken ground."),
    "ddr1": _i(50, 100, 0.65, 1.27, 150, 2, "SSTL-2: series (22 ohm) and parallel (50 ohm to VTT) termination on address, command and data unless point to point and short; data matched to its DQS per byte lane; address in a balanced tree (T) to the chips; VREF at half VDDQ, wide and decoupled; the differential clock a 100 ohm pair."),
    "ddr2": _i(50, 100, 0.25, 0.65, 125, 2, "SSTL-18: data uses on-die termination; address, command and control in a balanced tree (T) matched to the clock, with VTT termination for more than two chips; each byte lane on one layer matched to its DQS pair; VREF wide and decoupled."),
    "ddr3": _i(40, 80, 0.13, 0.5, 100, 2, "Data: each byte lane (8 DQ, DM) on one layer matched to its DQS pair; address, command and control routed fly-by from chip to chip in the clock's order, matched to the clock, ended in resistors to VTT; VREF wide, decoupled and quiet; data over ground, never over a split; the processor vendor's DDR layout guide is binding."),
    "ddr4": _i(40, 80, 0.13, 0.25, 100, 2, "As DDR3 with tighter matching; data referenced to ground on both sides where possible; address may reference VDD; point to point data, fly-by address with VTT termination; follow the processor vendor's guide and simulate anything unusual."),
    "ddr5": _i(40, 75, 0.13, 0.13, 75, 2, "Address and command are terminated on the die (no VTT resistors) and trained per pin; data per byte lane matched to its DQS within about a picosecond, with the package's own delays counted in; via stubs back-drilled or avoided, ground vias at every signal via; eight layers or more with data as stripline between grounds, low-loss laminate for long runs; the layout must follow the processor vendor's guide and be simulated."),
    "lpddr4": _i(40, 80, 0.13, 0.25, 50, 2, "Point to point, package under or beside the processor; HDI (via in pad) boards are normal; follow the vendor's reference layout exactly."),
    "emmc": _i(50, None, None, 2.5, 100, 2, "Clock, command and eight data lines matched to the clock; a series resistor (22 to 33 ohm) on the clock at the host; HS400 adds the data strobe and wants about 1 mm matching."),
    "sd": _i(50, None, None, 2.5, 100, 2, "Clock, command and data matched to the clock; pull-ups (10 k to 47 k) on command and data where the host has none; ESD part at the socket; a series resistor on the clock at the host; card detect debounced."),
    "qspi": _i(50, None, None, 2.5, 50, 2, "Flash right beside the processor; clock and data matched; a series resistor on the clock (and 0 ohm places on data) at the driving end; ground on both sides of the clock; nothing fast beside the crystal."),
    "spi": _i(None, None, None, None, 150, None, "Short, with ground beside or under the clock; a series resistor (22 to 47 ohm) at the driver of a clock longer than about 50 mm; one chip select per device, pulled up."),
    "i2c": _i(None, None, None, None, None, None, "Two pull-ups per bus, sized for its capacitance (kh.calc.i2c_pullup); at most 400 pF; keep SDA and SCL away from switch nodes; a buffer or lower speed for cables."),
    "i2s": _i(None, None, None, 5.0, 150, None, "The master clock is a clock: over ground, away from analog audio and the antenna, series resistor at its source; keep digital audio out of the analog section."),
    "jtag": _i(None, None, None, None, 150, None, "A series resistor on the clock at its driver; pull-ups or pull-downs as the chip asks; connector pads the probe can reach; reset on the connector."),
    "rf": _i(50, None, None, None, None, 0, "One width, an outer layer, no via, no stub, bends in arcs or at 135 degrees, unbroken ground on the next layer, ground vias down both sides no more than a twentieth of a wavelength apart, a pi matching network at the antenna or connector."),
}
_ALIAS = {"usb": "usb2", "usb20": "usb2", "usbhs": "usb2", "usb30": "usb3", "usb31": "usb3", "usbss": "usb3", "superspeed": "usb3", "tmds": "hdmi", "dp": "displayport", "edp": "displayport",
          "eth": "ethernet", "rgmii": "ethernet", "mdi": "ethernet", "sgmii": "pcie", "pciexpress": "pcie", "m2": "pcie", "nvme": "pcie", "csi": "mipi", "dsi": "mipi", "mipicsi": "mipi", "mipidsi": "mipi",
          "canfd": "can", "rs422": "rs485", "ddr": "ddr3", "ddr3l": "ddr3", "sdr": "sdram", "ddrsdram": "ddr1", "lpddr2": "ddr2", "lpddr3": "lpddr4", "lpddr5": "lpddr4", "mmc": "emmc", "sdio": "sd", "sdcard": "sd", "microsd": "sd", "ospi": "qspi", "flash": "qspi",
          "spiflash": "qspi", "octospi": "qspi", "iic": "i2c", "twi": "i2c", "swd": "jtag", "audio": "i2s", "antenna": "rf", "rf50": "rf", "lora": "rf", "gps": "rf", "gnss": "rf", "wifi": "rf", "ble": "rf", "bluetooth": "rf"}


def install(Project, Schematic, Board) -> None:      # noqa: ARG001
    Board.review = _board_review
    Board.plan = _layout_plan
    Board.prepare = _prepare
    Board.finish = _finish
    Board.antenna = _antenna
    Board.fence_net = _fence_net
    Board.thermal_vias = _thermal_vias
