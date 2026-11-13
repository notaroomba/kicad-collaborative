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
        if mirror:      # mirrored text runs toward smaller x from where it starts: start it at the right end of its room
            pos = (pos[0] + max(len(x) for x in lines) * sz * 0.9, pos[1])
        self.add_item(f'(gr_text "{text}" (at {_r(pos[0])} {_r(pos[1])}) (layer "{lay}") (uuid "{_uuid.uuid4()}") '
                      f'(effects (font (size {sz} {sz}) (thickness {_r(sz * 0.15)})) (justify left top{mirror})))')
        self.flush()
        return {"text": " / ".join(lines), "at": [_r(pos[0]), _r(pos[1])], "layer": lay, "size": sz}

    if at is not None:
        return emit(shapes[0], at, layer, size)
    if not o:
        raise HarnessError("The board has no outline yet; draw it first with board.outline(x0, y0, x1, y1), or give at=(x, y).")
    other = "B.SilkS" if layer.startswith("F.") else "F.SilkS"
    try:
        printed = self._call("get_geometry", silk=True).get("silk") or []
    except HarnessError:
        printed = []
    for lay in (layer, other):
        side = "back" if lay.startswith("B.") else "front"
        boxes = [b[:4] for b in printed if b[4] == lay]      # what is printed there already: references, pin names, outlines
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


def _silkscreen(self, name: str | bool | None = None, rev: str | None = None, date: str | None = None, org: str | None = None,
                size: float = 1.0, min_size: float | None = None, pin_labels: bool | list = True, refs: list | None = None, unhide: bool = False) -> dict:
    """The last pass of a layout, as a careful person does it by hand.  Call it when placement and routing are final.

    - Every reference designator goes beside its part where it lies on nothing: not a pad, not other silkscreen, not
      another part, not the board edge, and nearer to its own part than to any other.  One that does not fit at
      `size` is made smaller, turned on its side, or moved a little further out; it is hidden only when none of that
      finds a place.  `min_size` is the smallest it may get: by default the board's own rule (0.8 mm unless
      board.rules(min_text_height=...) says otherwise); 0.6 mm with a 0.1 mm pen is what most board houses still
      print, so on a crowded board set board.rules(min_text_height=0.6) first.  `refs` limits the pass to those parts, `unhide=True` also brings
      back references that are hidden now.
    - `pin_labels`: each connector pin's net name is printed beside it (True for every connector J/P/CN/X/BT, or a list
      of references; False for none).
    - The board's name, version and date are printed in free space (board.mark()) when the board has no such text yet;
      `name=False` leaves that out, and name / rev / date / org are passed on.

    Returns what it did: {"references", "moved", "resized": {ref: size}, "turned", "hidden", "pin_labels", "mark"}."""
    self.flush()
    out = {}
    if pin_labels:      # fixed by where the pins are, so they go first; then the name block, which needs the most room
        self._edit({"op": "silkscreen", "references": False, "pin_labels": True if pin_labels is True else list(pin_labels), "size": size, **({"min_size": min_size} if min_size else {})})
        res = self.flush() or {}
        d = next((x["silkscreen"] for x in res.get("details") or [] if "silkscreen" in x), {})
        out["pin_labels"] = d.get("pin_labels", {})
        if d.get("pin_labels_skipped"):
            out["pin_labels_skipped"] = d["pin_labels_skipped"]
    if name is not False:
        have = [it for it in self._call("get_items", kinds=["gr_text"]).get("items", []) if "SilkS" in it.get("sexpr", "")]
        if not have:
            try:
                out["mark"] = self.mark(name=name or None, rev=rev, date=date, org=org)
            except HarnessError as e:
                out["mark"] = {"problem": str(e)}
    e = {"op": "silkscreen", "size": size, "unhide": bool(unhide), **({"min_size": min_size} if min_size else {})}
    if refs:
        e["refs"] = list(refs)
    self._edit(e)
    res = self.flush() or {}
    d = next((x["silkscreen"] for x in res.get("details") or [] if "silkscreen" in x), {})
    for key in ("references", "moved", "resized", "turned", "hidden", "shown", "smallest", "min_size"):
        if d.get(key) not in (None, [], {}):
            out[key] = d[key]
    out.setdefault("references", 0)
    out.setdefault("hidden", [])
    return out


def _cleanup(self, merge: bool = True, vias: bool = True, in_pads: bool = False, dangling: bool = False, shorts: bool = False) -> dict:
    """Tidy the copper after routing, as KiCad's Cleanup Tracks & Vias does: segments in one line or lying on each
    other become one and a via on top of another goes.  `in_pads=True` also removes tracks wholly inside a pad (the
    router's short runs to the pad centre, which are kept by default), `dangling=True` track ends and vias that
    lead nowhere, `shorts=True` tracks that short two nets.  A connection the clean-up
    opened (it should open none) is routed again.  Returns {"removed", "changed", "by_kind", "reopened"}."""
    self.flush()
    before = self.unrouted()
    self._edit({"op": "cleanup", "merge": merge, "vias": vias, "in_pads": in_pads, "dangling": dangling, "shorts": shorts})
    try:
        res = self.flush() or {}
    except HarnessError as e:
        if "clean already" in str(e):
            return {"removed": 0, "changed": 0, "by_kind": {}, "reopened": {}}
        raise
    out = dict(next((x["cleanup"] for x in res.get("details") or [] if "cleanup" in x), {}))
    after = self.unrouted()
    opened = {n: c - before.get(n, 0) for n, c in after.items() if c > before.get(n, 0)}
    if opened:
        self.route(nets=list(opened), time_s=20)
        left = self.unrouted()
        opened = {n: left.get(n, 0) - before.get(n, 0) for n in opened if left.get(n, 0) > before.get(n, 0)}
    out["reopened"] = opened
    return out


_SUPPLY = re.compile(r"^/?(\+?\d+V\d*|\+?\d*V?\d+V\d*|VCC\w*|VDD\w*|VBUS\w*|VBAT\w*|VIN\w*|VSYS\w*|AVDD\w*|DVDD\w*|IOVDD\w*|\+\d.*)$", re.I)
_GROUND = re.compile(r"^/?(A|D|P)?(GND|VSS)\w*$", re.I)


def _ramp(v: float, good: float, bad: float) -> int:
    """100 at `good` or better, 0 at `bad` or worse, a straight line between."""
    if good == bad:
        return 100 if v == good else 0
    t = (v - bad) / (good - bad)
    return int(round(100 * min(1.0, max(0.0, t))))


def _tree_length(pts: list) -> float:
    """The shortest set of straight lines that joins the points (a minimum spanning tree): what a net needs at least."""
    if len(pts) < 2:
        return 0.0
    left, best, total = list(range(1, len(pts))), {i: math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]) for i in range(1, len(pts))}, 0.0
    while left:
        i = min(left, key=lambda k: best[k])
        total += best[i]
        left.remove(i)
        for k in left:
            best[k] = min(best[k], math.hypot(pts[k][0] - pts[i][0], pts[k][1] - pts[i][1]))
    return total


def _score(self) -> dict:
    """How good the layout is, as one number from 0 to 100 with the reasons: a quick way to compare two placements
    or to see what to fix next without looking at a picture.

    Parts of the score (each 0 to 100): `space` (courtyards fill 30 to 65 percent of the board), `connectors`
    (connectors sit at a board edge), `rotation` (parts stand at 0, 90, 180 or 270 degrees), `decoupling` (each small
    capacitor on a supply is within 3 mm of a pin it serves; 8 mm scores nothing), `tracks` (routed length against the
    least each net needs), `vias` (vias per routed net), `silkscreen` (no silkscreen warning in the rules check).
    Gates: an open connection, a rules error or a part off the board caps the score at 49.
    Returns {"score", "parts": {...}, "gates": [...], "worst": ["what is poor and the call that fixes it", ...]}."""
    self.flush()
    g = self.geometry()
    o = g.get("outline")
    parts = [p for p in g["parts"] if not re.match(r"(FID|REF\*\*|#|G|LOGO|H|MH)\d*", p["ref"])]
    nets = self.nets()
    chk = self.check(warnings=True)
    info = self.info()
    sub, worst, gates = {}, [], []
    pad_at = {f"{p['ref']}.{q[0]}": (q[1], q[2]) for p in g["parts"] for q in p.get("pads", [])}
    pad_net = {f"{p['ref']}.{q[0]}": q[3] for p in g["parts"] for q in p.get("pads", [])}
    # ---- gates
    left = sum(v["unrouted"] for v in nets.values())
    if left:
        gates.append(f"{left} connection{'s' if left > 1 else ''} not routed: board.route(), then board.unrouted()")
    if chk["errors"]:
        gates.append(f"{chk['errors']} rules error{'s' if chk['errors'] > 1 else ''}: board.check() lists them")
    if o:
        out = [p["ref"] for p in parts if (p.get("courtyard") or p.get("box")) and not (o[0] - 0.05 <= p["x"] <= o[2] + 0.05 and o[1] - 0.05 <= p["y"] <= o[3] + 0.05)]
        if out:
            gates.append(f"off the board: {', '.join(out[:8])}: board.place(ref, (x, y)) or board.autoplace()")
    # ---- space
    if o and parts:
        area = max(1e-6, (o[2] - o[0]) * (o[3] - o[1]))
        used = sum((b[2] - b[0]) * (b[3] - b[1]) for b in (p.get("courtyard") or p.get("box") for p in parts) if b) / area
        sub["space"] = _ramp(used, 0.30, 0.08) if used < 0.30 else _ramp(used, 0.65, 0.90)
        if sub["space"] < 70:
            worst.append((sub["space"], f"space: the parts cover {round(used * 100)}% of the board ({'make the outline smaller: board.outline(...)' if used < 0.30 else 'the board is crowded: a larger outline or parts on the back'})"))
    # ---- connectors at an edge
    conns = [p for p in parts if re.match(r"(J|P|CN|USB|X)\d", p["ref"]) and (p.get("courtyard") or p.get("box"))]
    if o and conns:
        far = []
        for p in conns:
            b = p.get("courtyard") or p["box"]
            d = min(b[0] - o[0], o[2] - b[2], b[1] - o[1], o[3] - b[3])
            if d > 1.5:
                far.append((d, p["ref"]))
        sub["connectors"] = int(round(100 * (1 - len(far) / len(conns))))
        if far:
            worst.append((sub["connectors"], "connectors: " + ", ".join(f"{r} is {round(d, 1)} mm from the nearest edge" for d, r in sorted(far, reverse=True)[:5]) + ": put connectors at an edge (board.autoplace(edge={ref: side}) or board.place)"))
    # ---- rotation
    if parts:
        odd = [p["ref"] for p in parts if abs((p.get("rotation") or 0) % 90) > 0.01]
        sub["rotation"] = int(round(100 * (1 - len(odd) / len(parts))))
        if odd:
            worst.append((sub["rotation"], f"rotation: {', '.join(odd[:8])} {'stand' if len(odd) > 1 else 'stands'} at an odd angle: board.place(ref, (x, y), rotation=0 or 90)"))
    # ---- decoupling
    caps, poor = [], []
    for p in parts:
        if not re.match(r"C\d", p["ref"]) or len(p.get("pads", [])) != 2:
            continue
        a, b = p["pads"]
        sup = a if _SUPPLY.match(a[3] or "") and _GROUND.match(b[3] or "") else b if _SUPPLY.match(b[3] or "") and _GROUND.match(a[3] or "") else None
        if sup is None:
            continue
        ics = [(math.hypot(q[1] - sup[1], q[2] - sup[2]), f"{ip['ref']}.{q[0]}") for ip in parts if re.match(r"(U|IC)\d", ip["ref"]) for q in ip.get("pads", []) if q[3] == sup[3]]
        if not ics:
            continue
        d, pin = min(ics)
        caps.append(_ramp(d, 3.0, 8.0))
        if d > 3.0:
            poor.append((d, f"{p['ref']} is {round(d, 1)} mm from {pin}"))
    if caps:
        sub["decoupling"] = int(round(sum(caps) / len(caps)))
        if poor:
            worst.append((sub["decoupling"], "decoupling: " + ", ".join(t for _, t in sorted(poor, reverse=True)[:5]) + ": move each capacitor to within 3 mm of the supply pin it serves (board.place)"))
    # ---- tracks and vias
    ratios, long = [], []
    for n, v in nets.items():
        pts = [pad_at[x] for x in v["pads"] if x in pad_at]
        need = _tree_length(pts)
        if v["unrouted"] or need < 1.0 or v["length_mm"] < need * 0.7:      # not routed, trivial, or carried by a pour
            continue
        r = v["length_mm"] / need
        ratios.append(r)
        if r > 1.8:
            long.append((r, f"{n} is {round(v['length_mm'], 1)} mm for {round(need, 1)} mm needed"))
    if ratios:
        sub["tracks"] = _ramp(sum(ratios) / len(ratios), 1.25, 2.5)
        if long:
            worst.append((sub["tracks"], "tracks: " + ", ".join(t for _, t in sorted(long, reverse=True)[:5]) + ": move the parts of these nets closer, or route them first (board.route(order=[...]))"))
        per = (info.get("vias") or 0) / len(ratios)
        sub["vias"] = _ramp(per, 0.6, 3.0)
        if sub["vias"] < 70:
            worst.append((sub["vias"], f"vias: {info.get('vias')} vias for {len(ratios)} routed nets: board.route(max_vias=2), or place parts so nets need not change sides"))
    # ---- silkscreen
    silk = sum(c for k, c in (chk.get("warnings_by_kind") or {}).items() if k.startswith("silk") or k.startswith("text"))
    sub["silkscreen"] = _ramp(silk, 0, 20)
    if silk:
        worst.append((sub["silkscreen"], f"silkscreen: {silk} silkscreen warning{'s' if silk > 1 else ''} in the rules check: board.silkscreen() clears every reference; what is left after it is a part's own outline at the board edge or over a pad"))
    weights = {"space": 1, "connectors": 1, "rotation": 1, "decoupling": 2, "tracks": 2, "vias": 1, "silkscreen": 1}
    total = sum(sub[k] * w for k, w in weights.items() if k in sub) / max(1, sum(w for k, w in weights.items() if k in sub))
    score = int(round(total))
    if gates:
        score = min(score, 49)
    return {"score": score, "parts": sub, "gates": gates, "worst": [t for _, t in sorted(worst)]}


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
    Board.silkscreen = _silkscreen
    Board.cleanup = _cleanup
    Board.score = _score
