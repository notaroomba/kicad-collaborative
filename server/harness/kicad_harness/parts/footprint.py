"""Footprints computed from package dimensions, after IPC-7351B.

Every generator takes the package's own dimensions (the numbers a datasheet's mechanical drawing
gives) and returns a `Footprint`: pads, courtyard, fabrication outline, silkscreen and the text of
a KiCad `.kicad_mod`.  Nothing is drawn by hand and nothing comes from a model.

Land pattern maths (IPC-7351B, nominal density "N"; "L" least and "M" most are also available):

    Zmax = Lmin + 2*Jtoe  + sqrt(Ltol^2 + F^2 + P^2)     outer extent of the pads
    Gmin = Smax - 2*Jheel - sqrt(Stol^2 + F^2 + P^2)     gap between the two rows
    Xmax = Wmin + 2*Jside + sqrt(Wtol^2 + F^2 + P^2)     pad width

with F = 0.05 (fabrication) and P = 0.05 (placement).
"""
from __future__ import annotations

import math
import uuid

F_TOL, P_TOL = 0.05, 0.05

# toe, heel, side fillet goals and courtyard excess per family and density
GOALS = {
    "gullwing":       {"L": (0.15, 0.25, 0.01, 0.10), "N": (0.35, 0.35, 0.03, 0.25), "M": (0.55, 0.45, 0.05, 0.50)},
    "gullwing_fine":  {"L": (0.15, 0.25, -0.04, 0.10), "N": (0.35, 0.35, -0.02, 0.25), "M": (0.55, 0.45, 0.01, 0.50)},   # pitch <= 0.625
    "nolead":         {"L": (0.20, 0.00, -0.04, 0.10), "N": (0.30, 0.00, -0.04, 0.25), "M": (0.40, 0.00, -0.04, 0.50)},
    "chip":           {"L": (0.15, -0.05, -0.05, 0.10), "N": (0.35, -0.05, 0.00, 0.25), "M": (0.55, -0.05, 0.05, 0.50)},
    "chip_small":     {"L": (0.10, -0.05, -0.05, 0.10), "N": (0.20, -0.05, 0.00, 0.15), "M": (0.30, -0.05, 0.05, 0.20)},     # smaller than 0603
    "sot":            {"L": (0.15, 0.25, 0.01, 0.10), "N": (0.35, 0.35, 0.03, 0.25), "M": (0.55, 0.45, 0.05, 0.50)},
}


def _rnd(v: float, step: float = 0.01) -> float:
    return round(round(v / step) * step, 4)


def _n(v: float) -> str:
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def land(l_min, l_max, t_min, t_max, w_min, w_max, goals):
    """(Z, G, X): outer pad extent, inner gap and pad width for a two-sided lead pattern.

    l = overall lead span, t = lead (terminal) length, w = lead width.
    """
    jt, jh, js = goals[0], goals[1], goals[2]
    l_tol, t_tol, w_tol = l_max - l_min, t_max - t_min, w_max - w_min
    s_min, s_max = l_min - 2 * t_max, l_max - 2 * t_min
    s_tol_rms = math.sqrt(l_tol ** 2 + 2 * t_tol ** 2)
    s_max_rms = s_max - (s_max - s_min - s_tol_rms) / 2
    z = l_min + 2 * jt + math.sqrt(l_tol ** 2 + F_TOL ** 2 + P_TOL ** 2)
    g = s_max_rms - 2 * jh - math.sqrt(s_tol_rms ** 2 + F_TOL ** 2 + P_TOL ** 2)
    x = w_min + 2 * js + math.sqrt(w_tol ** 2 + F_TOL ** 2 + P_TOL ** 2)
    return z, g, x


class Footprint:
    """Pads and outlines of one footprint, and its `.kicad_mod` text."""

    def __init__(self, name: str, description: str = "", tags: str = "", smd: bool = True):
        self.name, self.description, self.tags, self.smd = name, description, tags, smd
        self.pads: list = []          # dicts: number, x, y, w, h, shape, [drill], [layers]
        self.body = (0.0, 0.0)        # body size, for fab and silk
        self.courtyard = (0.0, 0.0, 0.0, 0.0)
        self.pin1 = (0.0, 0.0)
        self.notes: list = []

    def pad(self, number, x, y, w, h, shape="roundrect", drill=None, paste=True):
        self.pads.append({"number": str(number), "x": _rnd(x), "y": _rnd(y), "w": _rnd(w), "h": _rnd(h), "shape": shape, "drill": drill, "paste": paste})

    def finish(self, body_w, body_h, excess):
        """Courtyard around body and pads, grown by the excess and rounded outward to 0.05."""
        self.body = (body_w, body_h)
        x0 = min([-body_w / 2] + [p["x"] - p["w"] / 2 for p in self.pads]) - excess
        y0 = min([-body_h / 2] + [p["y"] - p["h"] / 2 for p in self.pads]) - excess
        x1 = max([body_w / 2] + [p["x"] + p["w"] / 2 for p in self.pads]) + excess
        y1 = max([body_h / 2] + [p["y"] + p["h"] / 2 for p in self.pads]) + excess
        up = lambda v: math.ceil(round(abs(v) / 0.05, 6)) * 0.05 * (1 if v >= 0 else -1)
        self.courtyard = (_rnd(up(x0)), _rnd(up(y0)), _rnd(up(x1)), _rnd(up(y1)))
        if self.pads:
            self.pin1 = (self.pads[0]["x"], self.pads[0]["y"])
        return self

    def summary(self) -> dict:
        c = self.courtyard
        return {"name": self.name, "pads": len(self.pads), "pad_size": [self.pads[0]["w"], self.pads[0]["h"]] if self.pads else None,
                "body": [round(self.body[0], 3), round(self.body[1], 3)], "courtyard": [round(c[2] - c[0], 2), round(c[3] - c[1], 2)], "notes": self.notes}

    # ---- KiCad text
    def sexpr(self) -> str:
        u = lambda: f'(uuid "{uuid.uuid4()}")'
        c = self.courtyard
        bw, bh = self.body
        out = [f'(footprint "{self.name}"', '\t(version 20241229)', '\t(generator "kicad_harness")', '\t(layer "F.Cu")']
        if self.description:
            out.append(f'\t(descr "{self.description}")')
        if self.tags:
            out.append(f'\t(tags "{self.tags}")')
        ty = _n(c[1] - 1.0)
        out.append(f'\t(property "Reference" "REF**" (at 0 {ty} 0) (layer "F.SilkS") {u()} (effects (font (size 1 1) (thickness 0.15))))')
        out.append(f'\t(property "Value" "{self.name}" (at 0 {_n(c[3] + 1.0)} 0) (layer "F.Fab") {u()} (effects (font (size 1 1) (thickness 0.15))))')
        out.append(f'\t(attr {"smd" if self.smd else "through_hole"})')
        line = lambda x0, y0, x1, y1, layer, w: f'\t(fp_line (start {_n(x0)} {_n(y0)}) (end {_n(x1)} {_n(y1)}) (stroke (width {w}) (type solid)) (layer "{layer}") {u()})'
        # courtyard
        out.append(f'\t(fp_rect (start {_n(c[0])} {_n(c[1])}) (end {_n(c[2])} {_n(c[3])}) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd") {u()})')
        # fabrication outline with a chamfered pin 1 corner (the corner nearest pad 1)
        x0, y0, x1, y1 = -bw / 2, -bh / 2, bw / 2, bh / 2
        ch = min(1.0, bw / 4, bh / 4)
        sx = -1 if self.pin1[0] <= 0 else 1
        sy = -1 if self.pin1[1] <= 0 else 1
        corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        pts = []
        for cx, cy in corners:
            if (cx < 0) == (sx < 0) and (cy < 0) == (sy < 0):
                a, b = (cx, cy - sy * ch), (cx - sx * ch, cy)
                pts += [a, b] if (cx < 0) == (cy < 0) else [b, a]
            else:
                pts.append((cx, cy))
        for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1]):
            out.append(line(ax, ay, bx, by, "F.Fab", 0.1))
        out.append(f'\t(fp_text user "${{REFERENCE}}" (at 0 0 0) (layer "F.Fab") {u()} (effects (font (size {_n(min(1, max(0.4, bw / 4)))} {_n(min(1, max(0.4, bw / 4)))}) (thickness 0.1))))')
        # silkscreen: body edges where no pad is in the way, kept 0.2 clear of copper, and a pin 1 mark
        for seg in self._silk():
            out.append(line(*seg, "F.SilkS", 0.12))
        if self.pads:
            p = self.pads[0]
            px = p["x"] - (p["w"] / 2 + 0.35) if abs(p["x"]) >= abs(p["y"]) else p["x"]
            py = p["y"] if abs(p["x"]) >= abs(p["y"]) else p["y"] - (p["h"] / 2 + 0.35)
            if abs(p["x"]) >= abs(p["y"]) and p["x"] > 0:
                px = p["x"] + p["w"] / 2 + 0.35
            if abs(p["x"]) < abs(p["y"]) and p["y"] > 0:
                py = p["y"] + p["h"] / 2 + 0.35
            out.append(f'\t(fp_circle (center {_n(px)} {_n(py)}) (end {_n(px + 0.1)} {_n(py)}) (stroke (width 0.2) (type solid)) (fill yes) (layer "F.SilkS") {u()})')
        for p in self.pads:
            if p["drill"]:
                shape = "rect" if p["number"] == "1" else "oval" if abs(p["w"] - p["h"]) > 1e-6 else "circle"
                out.append(f'\t(pad "{p["number"]}" thru_hole {shape} (at {_n(p["x"])} {_n(p["y"])}) (size {_n(p["w"])} {_n(p["h"])}) (drill {_n(p["drill"])}) (layers "*.Cu" "*.Mask") {u()})')
            else:
                rr = f' (roundrect_rratio {_n(min(0.25, 0.25 / max(0.05, min(p["w"], p["h"]))))})' if p["shape"] == "roundrect" else ""
                layers = '"F.Cu" "F.Mask" "F.Paste"' if p["paste"] else '"F.Cu" "F.Mask"'
                out.append(f'\t(pad "{p["number"]}" smd {p["shape"]} (at {_n(p["x"])} {_n(p["y"])}) (size {_n(p["w"])} {_n(p["h"])}) (layers {layers}){rr} {u()})')
        out.append('\t(embedded_fonts no)')
        out.append(')')
        return "\n".join(out) + "\n"

    def _silk(self):
        bw, bh = self.body
        o = 0.11
        x0, y0, x1, y1 = -bw / 2 - o, -bh / 2 - o, bw / 2 + o, bh / 2 + o
        clear = 0.2 + 0.06
        segs = []
        for (ax, ay, bx, by) in ((x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)):
            horizontal = abs(ay - by) < 1e-9
            lo, hi = sorted((ax, bx)) if horizontal else sorted((ay, by))
            cuts = []
            for p in self.pads:
                px0, px1 = p["x"] - p["w"] / 2 - clear, p["x"] + p["w"] / 2 + clear
                py0, py1 = p["y"] - p["h"] / 2 - clear, p["y"] + p["h"] / 2 + clear
                if horizontal and py0 < ay < py1:
                    cuts.append((px0, px1))
                if not horizontal and px0 < ax < px1:
                    cuts.append((py0, py1))
            cuts.sort()
            at = lo
            for c0, c1 in cuts:
                if c0 - at > 0.25:
                    segs.append((at, ay, c0, ay) if horizontal else (ax, at, ax, c0))
                at = max(at, c1)
            if hi - at > 0.25:
                segs.append((at, ay, hi, ay) if horizontal else (ax, at, ax, hi))
        return segs


def _mm(v) -> tuple:
    """A dimension as (min, max): a number, or a (min, max) or (min, nom, max) tuple."""
    if isinstance(v, (int, float)):
        return (float(v), float(v))
    v = [x for x in v if x is not None]
    return (float(min(v)), float(max(v)))


def _tol(v, plus_minus: float) -> tuple:
    lo, hi = _mm(v)
    return (lo - plus_minus, hi + plus_minus) if hi - lo < 1e-9 else (lo, hi)


# ---------------------------------------------------------------- generators

def dual(name: str, pins: int, pitch: float, span, lead_len, lead_width, body, density: str = "N", family: str | None = None,
         ep=None, description: str = "") -> Footprint:
    """Two rows of gull-wing leads: SOIC, SOP, SSOP, TSSOP, MSOP (and SOT with `sot`).

    span = overall width across the leads, lead_len = foot length, lead_width, body = (width, length);
    each may be a number or (min, max).  ep = (w, h) adds an exposed pad.
    """
    fam = family or ("gullwing_fine" if pitch <= 0.625 else "gullwing")
    goals = GOALS[fam][density]
    z, g, x = land(*_tol(span, 0.15), *_tol(lead_len, 0.15), *_tol(lead_width, 0.05), goals)
    x = min(x, pitch - 0.2) if pitch - 0.2 > 0.15 else x
    z, g = _rnd(z, 0.05), _rnd(g, 0.05)
    length, cx = _rnd((z - g) / 2, 0.05), _rnd((z + g) / 4)
    fp = Footprint(name, description or f"{pins}-lead package, pitch {pitch} mm, IPC-7351 density {density}", "SMD " + name.split("_")[0])
    half = pins // 2
    y0 = -(half - 1) * pitch / 2
    for i in range(half):
        fp.pad(i + 1, -cx, y0 + i * pitch, length, _rnd(x), "roundrect")
    for i in range(half):
        fp.pad(half + i + 1, cx, -y0 - i * pitch, length, _rnd(x), "roundrect")
    if ep:
        fp.pad(pins + 1, 0, 0, ep[0], ep[1], "rect")
    bw, bl = (sum(_mm(body[0])) / 2, sum(_mm(body[1])) / 2)
    return fp.finish(bw, bl, goals[3])


def quad(name: str, pins: int, pitch: float, span, lead_len, lead_width, body, density: str = "N", ep=None, description: str = "") -> Footprint:
    """Four rows of gull-wing leads: QFP, LQFP, TQFP.  span and body may be numbers (square) or (x, y) pairs of (min, max)."""
    fam = "gullwing_fine" if pitch <= 0.625 else "gullwing"
    goals = GOALS[fam][density]
    sx, sy = (span if _is_pair(span) else (span, span))
    bx, by = (body if _is_pair(body) else (body, body))
    fp = Footprint(name, description or f"{pins}-lead quad flat package, pitch {pitch} mm, IPC-7351 density {density}", "SMD QFP")
    per = pins // 4
    out = []
    for s in (sx, sy):
        z, g, x = land(*_tol(s, 0.15), *_tol(lead_len, 0.15), *_tol(lead_width, 0.05), goals)
        x = min(x, pitch - 0.2)
        out.append((_rnd((z - g) / 2, 0.05), _rnd((z + g) / 4), _rnd(x)))
    (lx, cx, wx), (ly, cy, wy) = out
    o = -(per - 1) * pitch / 2
    n = 1
    for i in range(per):
        fp.pad(n, -cx, o + i * pitch, lx, wx); n += 1
    for i in range(per):
        fp.pad(n, o + i * pitch, cy, wy, ly); n += 1
    for i in range(per):
        fp.pad(n, cx, -o - i * pitch, lx, wx); n += 1
    for i in range(per):
        fp.pad(n, -o - i * pitch, -cy, wy, ly); n += 1
    if ep:
        fp.pad(pins + 1, 0, 0, ep[0], ep[1], "rect")
    return fp.finish(sum(_mm(bx)) / 2, sum(_mm(by)) / 2, goals[3])


def _is_pair(v) -> bool:
    return isinstance(v, (tuple, list)) and len(v) == 2 and isinstance(v[0], (tuple, list))


def nolead(name: str, pins: int, pitch: float, body, lead_len, lead_width, density: str = "N", ep=None, sides: int | None = None,
           pins_x: int | None = None, description: str = "", _as_given: bool = False) -> Footprint:
    """Leadless packages: QFN (four sides) and DFN/SON (two sides).  body = (width, length); the terminals reach the body edge.

    sides = 2 or 4 (4 when the pin count divides by four and the body is near square); pins_x = terminals on each
    of the two sides along the length when the four sides differ.
    """
    goals = GOALS["nolead"][density]
    bw, bl = sum(_mm(body[0])) / 2, sum(_mm(body[1])) / 2
    if sides is None:
        sides = 4 if pins % 4 == 0 and pins >= 12 and abs(bw - bl) / max(bw, bl) < 0.35 else 2
    if sides == 2 and not _as_given:
        # A datasheet gives a two-sided package as D x E without saying which way the terminals run.  Both ways are
        # drawn; the one whose terminals fit along the body and whose exposed pad stays clear of them is the package.
        def ok(f, along):
            return (pins // 2 - 1) * pitch + sum(_mm(lead_width)) / 2 <= along + 0.05 and not any("exposed pad" in n for n in f.notes)
        given = nolead(name, pins, pitch, body, lead_len, lead_width, density, ep, 2, pins_x, description, _as_given=True)
        if ok(given, bl) or abs(bw - bl) < 0.05:
            return given
        g = lambda v: f"{sum(_mm(v)) / 2:g}"   # noqa: E731
        turned_name = name.replace(f"_{g(body[0])}x{g(body[1])}mm", f"_{g(body[1])}x{g(body[0])}mm")
        if ep:
            turned_name = turned_name.replace(f"EP{g(ep[0])}x{g(ep[1])}mm", f"EP{g(ep[1])}x{g(ep[0])}mm")
        turned = nolead(turned_name, pins, pitch, (body[1], body[0]), lead_len, lead_width, density, (ep[1], ep[0]) if ep else None, 2, pins_x, description, _as_given=True)
        if ok(turned, bw):
            turned.notes.append(f"the terminal rows are {g(body[1])} mm apart (the exposed pad and the pitch only fit that way)")
            return turned
        return given
    fp = Footprint(name, description or f"{pins}-terminal leadless package, pitch {pitch} mm, IPC-7351 density {density}", "SMD " + ("QFN" if sides == 4 else "DFN"))

    def row(size):
        z, g, x = land(*_tol(size, 0.1), *_tol(lead_len, 0.1), *_tol(lead_width, 0.05), goals)
        x = min(x, pitch - 0.15) if pitch >= 0.4 else min(x, pitch - 0.1)
        return _rnd((z - g) / 2, 0.05), _rnd((z + g) / 4), _rnd(x)

    if sides == 2:
        length, cx, w = row(body[0])
        half = pins // 2
        y0 = -(half - 1) * pitch / 2
        for i in range(half):
            fp.pad(i + 1, -cx, y0 + i * pitch, length, w)
        for i in range(half):
            fp.pad(half + i + 1, cx, -y0 - i * pitch, length, w)
    else:
        ny = pins_x if pins_x else pins // 4          # on the left and right
        nx = (pins - 2 * ny) // 2                      # on the bottom and top
        lx, cx, wx = row(body[0])
        ly, cy, wy = row(body[1])
        n = 1
        oy, ox = -(ny - 1) * pitch / 2, -(nx - 1) * pitch / 2
        for i in range(ny):
            fp.pad(n, -cx, oy + i * pitch, lx, wx); n += 1
        for i in range(nx):
            fp.pad(n, ox + i * pitch, cy, wy, ly); n += 1
        for i in range(ny):
            fp.pad(n, cx, -oy - i * pitch, lx, wx); n += 1
        for i in range(nx):
            fp.pad(n, -ox - i * pitch, -cy, wy, ly); n += 1
    if ep:
        fp.pad(pins + 1, 0, 0, ep[0], ep[1], "rect")
        # the pad must stay clear of the terminals
        def gap(p):   # from the exposed pad's edge to this terminal, along the side the terminal is on
            if sides == 2 or abs(p["x"]) > abs(p["y"]):
                return abs(p["x"]) - p["w"] / 2 - ep[0] / 2
            return abs(p["y"]) - p["h"] / 2 - ep[1] / 2
        if min(gap(p) for p in fp.pads[:-1]) < 0.15:
            fp.notes.append("exposed pad is closer than 0.15 mm to the terminals; check its size")
    return fp.finish(bw, bl, goals[3])


def sot(name: str, pins: int, pitch: float, span, lead_len, lead_width, body, layout: tuple | None = None, density: str = "N", description: str = "") -> Footprint:
    """Small outline transistors.  layout = (left positions, right positions) as pad numbers by row slot, top to bottom, with
    None for an empty slot: SOT-23 is ([1, None, 2], [None, 3, None]) and SOT-23-5 ([1, 2, 3], [5, None, 4])."""
    goals = GOALS["sot"][density]
    z, g, x = land(*_tol(span, 0.15), *_tol(lead_len, 0.15), *_tol(lead_width, 0.05), goals)
    z, g = _rnd(z, 0.05), _rnd(g, 0.05)
    length, cx, w = _rnd((z - g) / 2, 0.05), _rnd((z + g) / 4), _rnd(min(x, pitch - 0.2))
    if layout is None:
        layout = {3: ([1, None, 2], [None, 3, None]), 5: ([1, 2, 3], [5, None, 4]), 6: ([1, 2, 3], [6, 5, 4]), 8: ([1, 2, 3, 4], [8, 7, 6, 5])}[pins]
    fp = Footprint(name, description or f"{pins}-lead small outline transistor package, IPC-7351 density {density}", "SMD SOT")
    slots = len(layout[0])
    y0 = -(slots - 1) * pitch / 2
    pads = {}
    for side, col in ((-1, layout[0]), (1, layout[1])):
        for i, num in enumerate(col):
            if num is not None:
                pads[num] = (side * cx, y0 + i * pitch)
    for num in sorted(pads):
        fp.pad(num, pads[num][0], pads[num][1], length, w)
    return fp.finish(sum(_mm(body[0])) / 2, sum(_mm(body[1])) / 2, goals[3])


CHIP = {  # imperial code: (length, width, terminal length), with their tolerances
    "0201": ((0.6, 0.03), (0.3, 0.03), (0.15, 0.05)), "0402": ((1.0, 0.05), (0.5, 0.05), (0.25, 0.10)), "0603": ((1.6, 0.10), (0.8, 0.10), (0.30, 0.15)),
    "0805": ((2.0, 0.15), (1.25, 0.15), (0.40, 0.20)), "1206": ((3.2, 0.15), (1.6, 0.15), (0.50, 0.25)), "1210": ((3.2, 0.2), (2.5, 0.2), (0.50, 0.25)),
    "1812": ((4.5, 0.3), (3.2, 0.2), (0.60, 0.30)), "2010": ((5.0, 0.2), (2.5, 0.2), (0.60, 0.30)), "2512": ((6.3, 0.2), (3.2, 0.2), (0.60, 0.30)),
}
_METRIC = {"0201": "0603", "0402": "1005", "0603": "1608", "0805": "2012", "1206": "3216", "1210": "3225", "1812": "4532", "2010": "5025", "2512": "6332"}


def chip(code: str = "0603", kind: str = "R", density: str = "N", length=None, width=None, terminal=None, name: str | None = None) -> Footprint:
    """A two-terminal chip part (resistor, capacitor, inductor, LED) by its imperial size code, or by its own dimensions."""
    if code in CHIP:
        (l, lt), (w, wt), (t, tt) = CHIP[code]
        length, width, terminal = length or (l - lt, l + lt), width or (w - wt, w + wt), terminal or (max(0.05, t - tt), t + tt)
    if not (length and width and terminal):
        raise ValueError(f"chip size {code} is not known; give length, width and terminal")
    small = _mm(length)[1] < 1.5
    goals = GOALS["chip_small" if small else "chip"][density]
    z, g, x = land(*_mm(length), *_mm(terminal), *_mm(width), goals)
    z, g = _rnd(z, 0.05), max(_rnd(g, 0.05), 0.2)
    pl, cx = _rnd((z - g) / 2, 0.05), _rnd((z + g) / 4)
    fp = Footprint(name or (f"{kind}_{code}_{_METRIC[code]}Metric" if code in CHIP else f"{kind}_chip"), f"Chip {kind} {code}, IPC-7351 density {density}", f"SMD chip {kind}")
    fp.pad(1, -cx, 0, pl, _rnd(x, 0.05))
    fp.pad(2, cx, 0, pl, _rnd(x, 0.05))
    return fp.finish(sum(_mm(length)) / 2, sum(_mm(width)) / 2, goals[3])


def bga(name: str, columns: int, rows: int, pitch: float, ball: float, body, missing: list | None = None, description: str = "") -> Footprint:
    """A ball grid: pads named A1, A2 ... by row letter (I, O, Q, S, X, Z are skipped) and column number.

    The land is the ball reduced as IPC-7351 asks for collapsing balls: 25% for 0.75 mm, 20% for 0.5 to 0.65, 15% below.
    """
    cut = 0.25 if ball >= 0.75 else 0.20 if ball >= 0.5 else 0.15
    d = _rnd(ball * (1 - cut), 0.01)
    letters = [c for c in "ABCDEFGHJKLMNPRTUVWY"]
    letters += [a + b for a in letters for b in letters]
    gone = set(missing or [])
    fp = Footprint(name, description or f"{columns}x{rows} ball grid, pitch {pitch} mm, land {d} mm", "BGA")
    x0, y0 = -(columns - 1) * pitch / 2, -(rows - 1) * pitch / 2
    for r in range(rows):
        for c in range(columns):
            num = f"{letters[r]}{c + 1}"
            if num not in gone:
                fp.pad(num, x0 + c * pitch, y0 + r * pitch, d, d, "circle")
    return fp.finish(sum(_mm(body[0])) / 2, sum(_mm(body[1])) / 2, 1.0 if pitch >= 0.8 else 0.5)


def tht_dual(name: str, pins: int, pitch: float = 2.54, row_spacing: float = 7.62, lead_dia: float = 0.5, body=None, description: str = "") -> Footprint:
    """Through-hole dual in line (DIP).  Hole = lead + 0.25, pad = hole + 0.7 (IPC-2222 level B), pad 1 square."""
    hole = _rnd(lead_dia + 0.25, 0.05)
    pad = _rnd(max(hole + 0.7, 1.4), 0.05)
    fp = Footprint(name, description or f"{pins}-lead through-hole dual in line, row spacing {row_spacing} mm", "THT DIP", smd=False)
    half = pins // 2
    y0 = -(half - 1) * pitch / 2
    for i in range(half):
        fp.pad(i + 1, -row_spacing / 2, y0 + i * pitch, pad, pad, "rect", drill=hole)
    for i in range(half):
        fp.pad(half + i + 1, row_spacing / 2, -y0 - i * pitch, pad, pad, "rect", drill=hole)
    b = body or (row_spacing - 1.2, half * pitch)
    return fp.finish(b[0], b[1], 0.25)


def header(name: str, pins: int, rows: int = 1, pitch: float = 2.54, lead: float = 0.64, description: str = "") -> Footprint:
    """A pin header or socket strip, through-hole; lead is the pin's square side or diameter."""
    hole = _rnd(lead * (1.414 if lead >= 0.6 else 1) + 0.15, 0.05)
    pad = _rnd(min(pitch - 0.5, max(hole + 0.7, 1.4)), 0.05)
    fp = Footprint(name, description or f"{rows}x{pins // rows} pin header, pitch {pitch} mm", "THT header", smd=False)
    per = pins // rows
    y0 = -(per - 1) * pitch / 2
    x0 = -(rows - 1) * pitch / 2
    n = 1
    for i in range(per):
        for r in range(rows):
            fp.pad(n, x0 + r * pitch, y0 + i * pitch, pad, pad, "rect", drill=hole); n += 1
    return fp.finish(rows * pitch, per * pitch, 0.5)
