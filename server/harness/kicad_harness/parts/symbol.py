"""Schematic symbols drawn from a pin list.

A symbol is a rectangle with the pins sorted onto its sides the way KiCad's library convention
(KLC) asks: supplies on top, grounds at the bottom, inputs on the left, outputs on the right,
everything on a 2.54 mm grid.  Pins that share a name (several GND or VDD pins) are stacked on one
point: one is drawn, the others are hidden passive pins under it, so one wire connects them all.
"""
from __future__ import annotations

import math
import re

TYPES = {"input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"}
_GND = re.compile(r"^(A|D|P|E)?(GND|VSS|VEE|COM)\w*$|^(GND|VSS)|^(EP|EPAD|PAD|THERMAL|TAB)$", re.I)
_SUPPLY = re.compile(r"^(A|D|IO|U)?(VCC|VDD|VIN|VBAT|VBUS|VS|VM|VPP|VREF|AVDD|DVDD|IOVDD|VDDIO|VCCIO|V\+|VIO|VDDA|VDDD|VCORE|VCAP|VREG)\w*|^\+?\d+V\d*$|^V(DD|CC)", re.I)
_NC = re.compile(r"^(N\.?/?C\.?|NC\d*|DNC|NU|RSVD|RESERVED)$", re.I)
_OUT = re.compile(r"(OUT|TX|TXD|MISO|SDO|DO|Q\d*|INT|IRQ|ALERT|PG|PGOOD|RDY|DRDY|XOUT|SW|LX|BOOT|VOUT)\b", re.I)
_IN = re.compile(r"(^IN|IN$|RX|RXD|MOSI|SDI|DI\b|CLK|SCK|SCLK|CS|NSS|EN|ENABLE|RST|RESET|NRST|RUN|SHDN|ADDR|A\d$|XIN|WP|HOLD|TEST|MODE|SEL|FB|SENSE|BOOT0)", re.I)
_BIDI = re.compile(r"(^P[A-K]\d+|^GPIO|^IO\d|SDA|^D[+-]$|DP$|DM$|USB|SWDIO|^D\d+$|DQ|SDIO)", re.I)


def guess_type(name: str, said: str = "") -> str:
    """A pin's electrical type from the datasheet's type column when it has one, else from its name."""
    s = (said or "").strip().lower()
    n = name.strip()
    if _NC.match(n):
        return "no_connect"
    if s in TYPES:
        return s
    if s in ("i", "in", "di", "input", "ai", "a/i"):
        return "input"
    if s in ("o", "out", "do", "output", "ao"):
        return "output"
    if s in ("i/o", "io", "b", "bi", "i/o/z", "dio", "aio", "a/io", "bidirectional", "input/output"):
        return "bidirectional"
    if s in ("od", "oc", "o/d", "open drain", "open-drain"):
        return "open_collector"
    if s in ("p", "pwr", "s", "power", "supply", "g", "gnd", "ground", "pi", "p/i"):
        return "power_in"
    if s in ("po", "p/o"):
        return "power_out"
    if s in ("a", "analog", "passive"):
        return "passive"
    if _GND.match(n) or _SUPPLY.match(n):
        return "power_in"
    if _BIDI.search(n):
        return "bidirectional"
    if _OUT.search(n) and not _IN.search(n):
        return "output"
    if _IN.search(n):
        return "input"
    return "passive"


def _q(s: str) -> str:
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _n(v: float) -> str:
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def kicad_name(name: str) -> str:
    """A pin name the way KiCad writes it: an active-low /CS, nCS or CS# becomes ~{CS}."""
    n = name.strip()
    m = re.match(r"^[/\\!](\w[\w+\-]*)$", n) or re.match(r"^(\w[\w+\-]*)#$", n)
    if m:
        return "~{" + m.group(1) + "}"
    return n


def layout(pins: list) -> dict:
    """Sort pins onto the four sides.  pins: dicts with number, name, type.  Returns side -> list of stacks (lists of pins)."""
    groups: dict = {}
    order = []
    for p in pins:
        key = p["name"] if p["type"] in ("power_in", "power_out", "no_connect") and p["name"] else p["number"] + "\0"
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(p)
    sides = {"left": [], "right": [], "top": [], "bottom": []}
    for key in order:
        stack = groups[key]
        p = stack[0]
        n, t = p["name"], p["type"]
        if t in ("power_in", "power_out") and _GND.match(n):
            sides["bottom"].append(stack)
        elif t == "power_in":
            sides["top"].append(stack)
        elif t in ("output", "power_out", "open_collector", "open_emitter", "tri_state"):
            sides["right"].append(stack)
        elif t == "input":
            sides["left"].append(stack)
        elif t == "no_connect":
            sides["right"].append(stack)
        else:
            sides["left" if len(sides["left"]) <= len(sides["right"]) else "right"].append(stack)
    # a part with nothing on one side reads badly: balance left and right
    while len(sides["left"]) > len(sides["right"]) + 1 and any(s[0]["type"] not in ("input",) for s in sides["left"]):
        i = max(k for k, s in enumerate(sides["left"]) if s[0]["type"] != "input")
        sides["right"].append(sides["left"].pop(i))
    key = lambda s: [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s[0]["name"] or s[0]["number"])]
    for side in ("left", "right"):
        named = [s for s in sides[side] if s[0]["type"] != "no_connect"]
        nc = [s for s in sides[side] if s[0]["type"] == "no_connect"]
        sides[side] = sorted(named, key=key) + nc
    return sides


def symbol(name: str, pins: list, reference: str = "U", footprint: str = "", datasheet: str = "", description: str = "", keywords: str = "",
           extra: dict | None = None, sides: dict | None = None) -> tuple:
    """A KiCad symbol for a part.  pins: (number, name[, type]) tuples or dicts.  Returns (library text of the symbol, facts).

    facts has the same shape the engine gives for a library symbol (pins with dx, dy; body_box), so a part can be
    wired before anything is fetched.
    """
    ps = []
    for p in pins:
        if isinstance(p, dict):
            num, nm, ty = str(p["number"]), str(p.get("name", "")), p.get("type") or ""
        else:
            num, nm, ty = str(p[0]), str(p[1]) if len(p) > 1 else "", (p[2] if len(p) > 2 else "")
        ps.append({"number": num, "name": kicad_name(nm), "type": guess_type(nm, ty)})
    if sides is None:
        sides = layout(ps)
    else:       # the caller chose each side and its order: {side: [[pin, stacked pin, ...], ...]}, pins as dicts
        sides = {k: [None if st is None else [{"number": str(q["number"]), "name": kicad_name(str(q.get("name", ""))), "type": q.get("type") or "passive", "hidden": bool(q.get("hidden"))} for q in st] for st in sides.get(k, [])]
                 for k in ("left", "right", "top", "bottom")}
    g = 2.54
    nl, nr, nt, nb = (len(sides[s]) for s in ("left", "right", "top", "bottom"))
    longest = lambda side: max([len(re.sub(r"~\{(.*?)\}", r"\1", s[0]["name"])) for s in sides[side] if s] + [0])
    rows = max(nl, nr, 1)
    half_h = math.ceil(((rows - 1) * g / 2 + g + (g if nt or nb else 0)) / g) * g
    text_w = (longest("left") + longest("right")) * 1.0 + 5.08
    half_w = max(math.ceil(max(text_w, (max(nt, nb) + 1) * g, 10.16) / 2 / g) * g, 5.08)
    plen = 2.54
    out_pins, facts = [], []

    def emit(stack, x, y, angle):
        for i, p in enumerate(stack):
            hidden = i > 0 or bool(p.get("hidden"))
            ty = "passive" if i > 0 and p["type"] != "no_connect" else p["type"]
            out_pins.append(f'\t\t\t(pin {ty} line (at {_n(x)} {_n(y)} {angle}) (length {_n(plen)}){" (hide yes)" if hidden else ""} '
                            f'(name {_q(p["name"] or "~")} (effects (font (size 1.27 1.27)))) (number {_q(p["number"])} (effects (font (size 1.27 1.27)))))')
            facts.append({"number": p["number"], "name": p["name"], "type": ty, "dx": round(x, 3), "dy": round(-y, 3), **({"hidden": True} if hidden else {})})

    for side, x, angle in (("left", -half_w - plen, 0), ("right", half_w + plen, 180)):
        n = len(sides[side])
        y0 = (n - 1) * g / 2
        y0 = math.floor(y0 / g) * g if (n % 2 == 0) else y0   # keep every pin on the 2.54 grid
        for i, stack in enumerate(sides[side]):
            if stack:           # None is an empty row, left free between groups of pins
                emit(stack, x, y0 - i * g, angle)
    for side, y, angle in (("top", half_h + plen, 270), ("bottom", -half_h - plen, 90)):
        n = len(sides[side])
        x0 = -math.floor((n - 1) / 2) * g
        for i, stack in enumerate(sides[side]):
            emit(stack, x0 + i * g, y, angle)
    props = [("Reference", reference, f"(at {_n(-half_w)} {_n(half_h + 1.27)} 0)", '(effects (font (size 1.27 1.27)) (justify left bottom))'),
             ("Value", name, f"(at {_n(half_w)} {_n(half_h + 1.27)} 0)", '(effects (font (size 1.27 1.27)) (justify right bottom))'),
             ("Footprint", footprint, "(at 0 0 0)", '(effects (font (size 1.27 1.27)) (hide yes))'),
             ("Datasheet", datasheet or "~", "(at 0 0 0)", '(effects (font (size 1.27 1.27)) (hide yes))'),
             ("Description", description, "(at 0 0 0)", '(effects (font (size 1.27 1.27)) (hide yes))')]
    if keywords:
        props.append(("ki_keywords", keywords, "(at 0 0 0)", '(effects (font (size 1.27 1.27)) (hide yes))'))
    for k, v in (extra or {}).items():
        props.append((k, v, "(at 0 0 0)", '(effects (font (size 1.27 1.27)) (hide yes))'))
    lines = [f'\t(symbol {_q(name)}', '\t\t(exclude_from_sim no)', '\t\t(in_bom yes)', '\t\t(on_board yes)']
    for k, v, at, eff in props:
        lines.append(f'\t\t(property {_q(k)} {_q(v)} {at} {eff})')
    lines.append(f'\t\t(symbol {_q(name + "_0_1")}')
    lines.append(f'\t\t\t(rectangle (start {_n(-half_w)} {_n(half_h)}) (end {_n(half_w)} {_n(-half_h)}) (stroke (width 0.254) (type default)) (fill (type background)))')
    lines.append('\t\t)')
    lines.append(f'\t\t(symbol {_q(name + "_1_1")}')
    lines += out_pins
    lines.append('\t\t)')
    lines.append('\t\t(embedded_fonts no)')
    lines.append('\t)')
    text = "\n".join(lines) + "\n"
    info = {"lib_id": f"Generated:{name}", "reference_prefix": reference, "value": name,
            "units": [{"unit": 1, "body_box": [round(-half_w - plen, 3), round(-half_h - plen, 3), round(half_w + plen, 3), round(half_h + plen, 3)], "pins": facts}]}
    return text, info


def library(symbols: list) -> str:
    """A .kicad_sym file holding the given symbol texts."""
    return '(kicad_symbol_lib\n\t(version 20241209)\n\t(generator "kicad_harness")\n\t(generator_version "9.0")\n' + "".join(symbols) + ")\n"
