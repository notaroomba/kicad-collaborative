"""The house design rules as calls: the review against the checklists, and what the checklists ask a design to carry.

The rules are Andrew Greenberg's "Actually Useful Schematics" (KiCon 2025) with his Checklist for Schematics and
Checklist for PCB Layout, and Graham Sutherland's "Creating high quality electronics schematics".  `review()` judges
a sheet or the board against every item a program can judge (the engine does the judging, so the MCP tool
`review_design` gives the same answer); the other calls add what the lists ask for: global labels with a direction
on net stubs, supplies with their voltage range and current written down, test points, MFR and MPN fields,
fiducials, the board's name and version on the silkscreen, ground stitching.

The methods are attached to Schematic, Board and Project when the package is imported.
"""
from __future__ import annotations

import datetime as _dt
import math
import re
import uuid as _uuid

from .transport import HarnessError

_LINE = 2.286


def _r(v: float) -> float:
    return round(v, 4)


# ---------------------------------------------------------------- review

def _review(self, level: str | None = None, rule: str | None = None, limit: int = 40) -> dict:
    """Check this sheet or board against the house checklists.

    Returns {"errors", "warnings", "notes", "passed": [rule ids], "findings": ["error power.direction: ... [items]"],
    "manual": [what only a person can judge]}.  `level="error"` lists only errors, `rule="power"` one family.
    A design is not finished while errors are listed; fix warnings or say in a note on the sheet why one stands.
    """
    args = {k: v for k, v in (("level", level), ("rule", rule)) if v}
    r = self._call("review_design", **args)
    rows = []
    for f in r.get("findings", [])[:limit]:
        rows.append(f"{f['level']} {f['rule']}: {f['message']}" + (f" [{'; '.join(f['items'])}]" if f.get("items") else ""))
    out = {"check": r.get("check"), "errors": r.get("errors", 0), "warnings": r.get("warnings", 0), "notes": r.get("notes", 0),
           "passed": r.get("passed", []), "findings": rows, "manual": r.get("manual", [])}
    self.project.note(f"{getattr(self, 'path', 'document')}: review {out['errors']} errors, {out['warnings']} warnings, {len(out['passed'])} of {r.get('rules', 0)} rules clean")
    return out


def _project_review(self, level: str | None = "warning") -> dict:
    """Review every sheet and the board; one entry per document."""
    out = {}
    for d in self._docs:
        doc = self._doc(d["path"], d["type"]) if d["type"] in ("schematic", "board") else None
        if doc is None:
            continue
        try:
            out[d["path"]] = doc.review(level=level)
        except HarnessError as e:
            out[d["path"]] = {"error": str(e)}
    return out


# ---------------------------------------------------------------- schematic

def _globalize(self, *names: str, all: bool = False) -> int:   # noqa: A002
    """Turn the plain labels that sit on a wire end or straight on a pin into global labels with a direction shape
    (input, output, bidirectional, passive, from the pins on the wire).  A net that continues somewhere else by name must
    say so; a plain label reads as the name of a wire.  Names in the middle of a wire stay as they are.  Without names
    every label whose name is used more than once is converted; `all=True` converts single ones too.  Returns the count."""
    self.flush()
    e: dict = {"op": "globalize_labels"}
    if names:
        e["names"] = list(names)
    if all:
        e["all"] = True
    self._edit(e)
    try:
        res = self.flush() or {}
    except HarnessError as err:
        if "no plain label" in str(err):
            return 0
        raise
    d = next((x["globalize_labels"] for x in res.get("details") or [] if "globalize_labels" in x), {})
    return int(d.get("converted", 0))


def _fmt_range(v, unit: str, scale: float = 1.0) -> str:
    if v is None:
        return ""
    if isinstance(v, (int, float)):
        return f"{v * scale:g} {unit}"
    v = (list(v) + [None, None, None])[:3]
    return "(" + ", ".join("" if x is None else f"{x * scale:g}" for x in v) + f") {unit}"


def _supplies(self, table: dict, at=None, title: str = "Power supplies (min, typ, max)") -> list:
    """Write down what each supply is: {"VUSB": {"volts": (4.5, 5.0, 5.5), "amps": (None, 0.035, 0.5), "from": "J1"}}
    becomes the line "VUSB = (4.5, 5, 5.5) V @ (, 35, 500) mA from J1" in a list on the sheet (in free space, or at `at`).
    A reader then knows the range and the load of every rail without opening a datasheet, and the review uses the
    stated maximum to check capacitor voltage ratings and resistor dissipation.  A single number is taken as typical."""
    lines = []
    for name, spec in table.items():
        spec = spec if isinstance(spec, dict) else {"volts": spec}
        amps = spec.get("amps")
        small = amps is not None and max([abs(x) for x in ([amps] if isinstance(amps, (int, float)) else amps) if x is not None] + [0]) < 1
        line = f"{name} = {_fmt_range(spec.get('volts'), 'V')}"
        if amps is not None:
            line += " @ " + (_fmt_range(amps, "mA", 1000) if small else _fmt_range(amps, "A"))
        if spec.get("from"):
            line += f" from {spec['from']}"
        if spec.get("note"):
            line += f" ({spec['note']})"
        lines.append(line)
        if not self._is_power(name):
            self.supply(name)
    if not lines:
        return []
    self.flush()
    w = max(self._width(title) * 1.1, max(self._width(x) for x in lines)) + 1.5
    h = (len(lines) + 1) * _LINE + 1.0
    if at is None:
        spot = self._call("check_layout", limit=1, free={"w": _r(w), "h": _r(h)}).get("free")
        if not spot:
            raise HarnessError("There is no free space for the supply list on the page; make the page larger with page(\"A2\") or give at=(x, y).")
        at = (spot["x"], spot["y"])
    y = at[1] + _LINE
    self.text(title, (at[0] + 0.5, y), bold=True)
    for line in lines:
        y += _LINE
        self.text(line, (at[0] + 0.5, y))
    self.flush()
    return [_r(at[0]), _r(at[1])]


def _test_point(self, net: str, ref: str | None = None, expect: str | None = None,
                footprint: str = "TestPoint:TestPoint_Pad_D1.0mm") -> str:
    """A test point on a net ("+3V3", "GND", "~{RESET}" or a pin like "U1.RUN").  `expect` is written beside it
    ("3.3 V", "low while in reset"): tell the reader what to expect at a test point.  Returns its reference."""
    self.flush()
    name = net
    if "." in net and not self._is_power(net):
        try:
            name = self.pin(net)["net"] or net
        except HarnessError:
            name = net
    at = None
    try:      # room for the point, its supply symbol or label and its note, clear of the blocks
        spot = self._call("check_layout", limit=1, free={"w": 25.4, "h": 20.32}).get("free")
        if spot:
            at = (round((spot["x"] + 10.16) / 1.27) * 1.27, round((spot["y"] + 10.16) / 1.27) * 1.27)
    except HarnessError:
        pass
    tp = self.place("Connector:TestPoint", at=at, ref=ref, value=name.lstrip("/"), footprint=footprint)
    self.flush()
    if name != net and (not name or name.startswith(("Net-(", "unconnected-"))):
        self.connect(net, f"{tp}.1")
    else:
        self.net(name, f"{tp}.1")
    self.flush()
    if expect:
        try:
            self.note(f"{tp}: expect {expect}", near=tp)
        except HarnessError:
            pass
    return tp


def _bom(self, ref: str, mfr: str | None = None, mpn: str | None = None, **more) -> None:
    """The ordering fields of a part: sch.bom("U1", mfr="Texas Instruments", mpn="TLV62569DBVR", LCSC="C141836",
    Voltage="16V", Power="0.1W").  MFR and MPN are what the checklist asks of every component."""
    fields = {k: v for k, v in (("MFR", mfr), ("MPN", mpn)) if v}
    fields.update({k: v for k, v in more.items() if v is not None})
    if fields:
        self.set(ref, **fields)


def _fiducials(self, count: int = 3, footprint: str = "Fiducial:Fiducial_1mm_Mask2mm") -> list:
    """Fiducial marks for pick and place (three per assembled side).  Places the symbols; board.sync() brings them
    across and board.fiducials() puts them in the corners."""
    have = [r for r in self.refs() if re.match(r"FID\d", r)]
    out = list(have)
    need = count - len(have)
    if need <= 0:
        return out
    self.flush()
    spot = None
    try:      # a row of them in free room, clear of the blocks
        spot = self._call("check_layout", limit=1, free={"w": 15.24 * need + 5.08, "h": 15.24}).get("free")
    except HarnessError:
        pass
    for k, i in enumerate(range(len(have), count)):
        at = (round((spot["x"] + 7.62 + k * 15.24) / 1.27) * 1.27, round((spot["y"] + 8.89) / 1.27) * 1.27) if spot else None
        out.append(self.place("Mechanical:Fiducial", at=at, ref=f"FID{i + 1}", footprint=footprint))
    self.flush()
    return out


# ---------------------------------------------------------------- board

def _corner_spots(self, inset: float):
    g = self.geometry()
    o = g.get("outline")
    if not o:
        raise HarnessError("The board has no outline yet; draw it first with board.outline(x0, y0, x1, y1).")
    x0, y0, x1, y1 = o
    return g, [(x0 + inset, y0 + inset), (x1 - inset, y1 - inset), (x0 + inset, y1 - inset), (x1 - inset, y0 + inset)]


def _free_at(g, at, r: float, skip=()) -> bool:
    for p in g["parts"]:
        if p["ref"] in skip:
            continue
        b = p.get("courtyard") or p.get("box")
        if b and at[0] > b[0] - r and at[0] < b[2] + r and at[1] > b[1] - r and at[1] < b[3] + r:
            return False
    return True


def _clear_of_pads(g, at, net: str, r: float) -> bool:
    """A stitching via may stand inside a part's courtyard (beside a header row, under a switch): what it must stay off
    is the pads of other nets.  The rules check that follows takes out any that still sits too close to copper."""
    for p in g["parts"]:
        for q in p["pads"]:
            if q[3] != net and math.hypot(at[0] - q[1], at[1] - q[2]) < r:
                return False
    return True


def _board_fiducials(self, inset: float = 2.5) -> dict:
    """Put the board's fiducials (FID1..) in three corners, as far apart as the outline allows, clear of other parts.
    The schematic must have them first (sch.fiducials(), then board.sync())."""
    self.flush()
    g, corners = _corner_spots(self, inset)
    fids = sorted(p["ref"] for p in g["parts"] if re.match(r"FID\d", p["ref"]))
    if not fids:
        raise HarnessError("The board has no fiducials. Add them in the schematic with sch.fiducials(), then board.sync().")
    o = g["outline"]
    placed = {}
    for ref, c in zip(fids, corners):
        at, step = c, 1.0
        dx = 1 if c[0] < (o[0] + o[2]) / 2 else -1
        dy = 1 if c[1] < (o[1] + o[3]) / 2 else -1
        for n in range(40):      # walk along the edge, then inward, until the mark and its mask opening are in the clear
            cands = [(c[0] + dx * n * step, c[1]), (c[0], c[1] + dy * n * step), (c[0] + dx * n * step, c[1] + dy * n * step)]
            hit = next((q for q in cands if _free_at(g, q, 1.2, skip=fids)), None)
            if hit:
                at = hit
                break
        self.place(ref, (_r(at[0]), _r(at[1])))
        placed[ref] = [_r(at[0]), _r(at[1])]
    self.flush()
    for ref, at in placed.items():      # bare board around the mark, so no pour or track fills its mask opening
        side = next((p.get("side", "front") for p in g["parts"] if p["ref"] == ref), "front")
        try:
            self.keepout([_r(at[0] - 1.15), _r(at[1] - 1.15), _r(at[0] + 1.15), _r(at[1] + 1.15)], layers=["B.Cu" if side == "back" else "F.Cu"], name=f"{ref} clear")
        except HarnessError:
            pass
    self.flush()
    return placed


def _mark(self, name: str | None = None, rev: str | None = None, date: str | None = None, org: str | None = None,
          at=None, layer: str = "F.SilkS", size: float = 1.0) -> dict:
    """Print the board's identity on the silkscreen: organisation, name, version and date (today's by default), as the
    layout checklist asks.  It goes in free space, from the bottom edge up, on one line or broken over two or three and
    in smaller type where the board is crowded, and on the back when the front has no room; `at` (top left of the text) puts it exactly there."""
    self.flush()
    date = date or _dt.date.today().isoformat()
    name = name or self.project.name
    tail = " ".join(x for x in (rev, date) if x)
    shapes = [[" ".join(x for x in (org, name, tail) if x)]]
    if org:
        shapes.append([org, " ".join(x for x in (name, tail) if x)])
    shapes.append([x for x in (org, name, tail) if x])
    g = self.geometry()
    o = g.get("outline")

    def emit(lines, pos, lay, sz):
        mirror = " mirror" if lay.startswith("B.") else ""
        text = "\\n".join(lines)
        self.add_item(f'(gr_text "{text}" (at {_r(pos[0])} {_r(pos[1])}) (layer "{lay}") (uuid "{_uuid.uuid4()}") '
                      f'(effects (font (size {sz} {sz}) (thickness {_r(sz * 0.15)})) (justify left top{mirror})))')
        self.flush()
        return {"text": " / ".join(lines), "at": [_r(pos[0]), _r(pos[1])], "layer": lay, "size": sz}

    if at is not None:
        return emit(shapes[0], at, layer, size)
    if not o:
        raise HarnessError("The board has no outline yet; draw it first with board.outline(x0, y0, x1, y1), or give at=(x, y).")
    other = "B.SilkS" if layer.startswith("F.") else "F.SilkS"
    for lay in (layer, other):
        side = "back" if lay.startswith("B.") else "front"
        boxes = []
        for p in g["parts"]:
            b = p.get("courtyard") or p.get("box")
            if b and (p.get("side", "front") == side or len(p.get("pads", [])) > 0 and re.match(r"(J|P|H|MH|TP)\d", p["ref"])):
                boxes.append(b)
        for sz in dict.fromkeys((size, 0.8, 0.6)):
            if sz > size:
                continue
            for lines in shapes:
                w, h = max(len(x) for x in lines) * sz * 0.9 + 0.4, len(lines) * sz * 1.65 + 0.3
                if w > o[2] - o[0] - 1.6 or h > o[3] - o[1] - 1.6:
                    continue
                y = o[3] - 0.8 - h
                while y >= o[1] + 0.8:
                    x = o[0] + 0.8
                    while x + w <= o[2] - 0.8:
                        hit = next((b for b in boxes if x < b[2] + 0.25 and x + w > b[0] - 0.25 and y < b[3] + 0.25 and y + h > b[1] - 0.25), None)
                        if hit is None:
                            return emit(lines, (x + 0.2, y + 0.15), lay, sz)
                        x = max(x + 0.5, hit[2] + 0.3)
                    y -= 0.5
    raise HarnessError(f"There is no room for \"{shapes[0][0]}\" on the silkscreen of either side, even at 0.6 mm in three lines; give at=(x, y).")


def _stitch(self, spacing: float = 10.0, net: str = "GND", margin: float = 1.5, size: float | None = None, drill: float | None = None) -> dict:
    """Tie the ground planes together with a grid of vias, about every `spacing` mm, wherever one fits: clear of
    parts, and taken back out wherever the rules check says it is too close to other copper.  Call it after routing,
    with ground poured on at least two layers."""
    self.flush()
    g = self.geometry()
    o = g.get("outline")
    if not o:
        raise HarnessError("The board has no outline yet.")
    name = self._net(net)
    pts = []
    nx = max(1, int((o[2] - o[0] - 2 * margin) // spacing))
    ny = max(1, int((o[3] - o[1] - 2 * margin) // spacing))
    for i in range(nx + 1):
        for j in range(ny + 1):
            c = (o[0] + margin + i * (o[2] - o[0] - 2 * margin) / nx, o[1] + margin + j * (o[3] - o[1] - 2 * margin) / ny)
            reach = int(spacing / 2)      # the nearest clear spot around the grid point, within half a pitch
            near = sorted(((dx, dy) for dx in range(-reach, reach + 1) for dy in range(-reach, reach + 1)), key=lambda q: q[0] * q[0] + q[1] * q[1])
            for dx, dy in near:
                at = (_r(c[0] + dx), _r(c[1] + dy))
                if o[0] + margin <= at[0] <= o[2] - margin and o[1] + margin <= at[1] <= o[3] - margin and _free_at(g, at, 0.6) and all(abs(at[0] - q[0]) + abs(at[1] - q[1]) > spacing / 2 for q in pts):
                    pts.append(at)
                    break
    ids = {}
    for at in pts:      # one batch each, so each via's id is known and a bad one can be taken out again
        self.via(name, at, size=size, drill=drill)
        res = self.flush() or {}
        new = (res.get("added") or [None])[-1]
        if new:
            ids[new] = at
    removed = 0
    if ids:
        r = self._call("run_checks")
        bad = set()
        for v in r.get("violations", []):
            if v.get("severity") != "error" or v.get("code") in ("unconnected_items",):
                continue
            for vid, at in ids.items():
                if abs(v["x"] - at[0]) < 1.0 and abs(v["y"] - at[1]) < 1.0:
                    bad.add(vid)
        for vid in bad:
            self._edit({"op": "remove", "id": vid})
            removed += 1
        self.flush()
    out = {"vias": len(ids) - removed, "tried": len(pts), "removed": removed}
    self.project.note(f"board: {out['vias']} ground stitching vias")
    return out


def _fence(self, path, spacing: float = 1.0, net: str = "GND", offset: float = 0.0, size: float | None = None, drill: float | None = None) -> dict:
    """A row of vias on `net` along a path you choose: `path` is a list of points [(x, y), ...] in mm and a via goes
    every `spacing` mm along it.  With `offset` the path is a centre line (a trace, the edge of a section) and two rows
    are placed, one each side, `offset` mm from it: the fence beside an antenna feed or around a noisy block.  A via that
    would stand on or beside a pad of another net, or that the rules check finds too close to other copper, is left out.
    Returns {"vias", "tried", "removed"}."""
    self.flush()
    pts_in = [(float(p[0]), float(p[1])) for p in path]
    if len(pts_in) < 2:
        raise HarnessError("Give the path as at least two points: [(x0, y0), (x1, y1), ...].")
    if spacing <= 0:
        raise HarnessError("spacing is the distance between vias in mm.")
    g = self.geometry()
    name = self._net(net)
    rows = [0.0] if not offset else [offset, -offset]
    pts = []
    for side in rows:
        carry = 0.0     # how far into the next segment the next via falls
        for (ax, ay), (bx, by) in zip(pts_in, pts_in[1:]):
            L = math.hypot(bx - ax, by - ay)
            if L < 1e-6:
                continue
            ux, uy = (bx - ax) / L, (by - ay) / L
            d = carry
            while d <= L + 1e-6:
                at = (_r(ax + ux * d - uy * side), _r(ay + uy * d + ux * side))
                if _clear_of_pads(g, at, name, 0.9) and all(math.hypot(at[0] - q[0], at[1] - q[1]) > spacing * 0.6 for q in pts):
                    pts.append(at)
                d += spacing
            carry = d - L
    out = _vias_checked(self, name, pts, size, drill)
    self.project.note(f"board: fence of {out['vias']} vias on {name}")
    return out


def _vias_checked(self, name: str, pts: list, size, drill) -> dict:
    """Place a via at each point, then take out those the rules check finds at fault."""
    ids = {}
    for at in pts:      # one batch each, so each via's id is known and a bad one can be taken out again
        self.via(name, at, size=size, drill=drill)
        res = self.flush() or {}
        new = (res.get("added") or [None])[-1]
        if new:
            ids[new] = at
    removed = 0
    if ids:
        r = self._call("run_checks")
        bad = set()
        for v in r.get("violations", []):
            if v.get("severity") != "error" or v.get("code") in ("unconnected_items",):
                continue
            for vid, at in ids.items():
                if abs(v["x"] - at[0]) < 0.6 and abs(v["y"] - at[1]) < 0.6:
                    bad.add(vid)
        for vid in bad:
            self._edit({"op": "remove", "id": vid})
            removed += 1
        self.flush()
    return {"vias": len(ids) - removed, "tried": len(pts), "removed": removed}


def install(Project, Schematic, Board) -> None:
    Schematic.review = _review
    Board.review = _review
    Project.review = _project_review
    Schematic.globalize = _globalize
    Schematic.supplies = _supplies
    Schematic.test_point = _test_point
    Schematic.bom = _bom
    Schematic.fiducials = _fiducials
    Board.fiducials = _board_fiducials
    Board.mark = _mark
    Board.stitch = _stitch
    Board.fence = _fence
