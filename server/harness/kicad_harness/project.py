"""Projects, schematic sheets and boards as plain Python objects.

Nothing here writes KiCad file text.  Each method turns into one or a few edits for the design
engine (the editor's own code), which keeps the files valid and, on an online project, sends the
edits to everyone in the document.  Results are short summaries: references, counts and what
went wrong, never file contents.
"""
from __future__ import annotations

import math
import random
import re
import uuid as _uuid

from .transport import HarnessError, Transport

GRID = 1.27
STUB = 2.54
_PAD = 3.81      # between a frame and what it holds
_HEAD = 6.35     # the strip a frame's heading takes
_TITLE = 2.54    # heading text height
_LINE = 2.286    # pitch of note lines
_PAPERS = [("A4", 297.0, 210.0), ("A3", 420.0, 297.0), ("A2", 594.0, 420.0), ("A1", 841.0, 594.0), ("A0", 1189.0, 841.0)]
_STAGE = (1524.0, 127.0)   # blocks are drawn off the page first, measured, then moved into place
_DIR = {"left": (-1, 0), "right": (1, 0), "top": (0, -1), "bottom": (0, 1)}
_LABEL_ROT = {"left": 180, "right": 0, "top": 90, "bottom": 270}
_GND_ROT = {"bottom": 0, "right": 90, "top": 180, "left": 270}
_SUPPLY_ROT = {"top": 0, "left": 90, "bottom": 180, "right": 270}
_GROUND = re.compile(r"^(A|D|P)?(GND|VSS|VEE)|^GND|^-\d|^Earth", re.I)
# names that read as a supply although KiCad's power library has no symbol for them; a measurement or control net named after one is not
_SUPPLY = re.compile(r"^(\+.+|[AD]?V(DD|CC|BUS|BAT|BATT|SYS|IN|OUT|REF|IO|PP|AA|M|CORE|REG|USB|DC|MAIN|RTC|SPI)(_?[A-Z0-9+.]+)*)$")
_NOT_SUPPLY = re.compile(r"SENSE|ADC|MON|DIV|DET|_EN$|_OK$|_PG$|FB|_ON$", re.I)
_POWER = re.compile(r"^(\+?\d+V\d*|\+\d.*|-\d+V\d*|GND\w*|VCC\w*|VDD\w*|VSS\w*|VEE\w*|VBUS|VBAT|VAA|VPP|\+BATT|-BATT|Earth\w*|[ADP]GND\w*)$")


def _snap(v: float, g: float = GRID) -> float:
    return round(round(v / g) * g, 4)


def _r(v: float) -> float:
    return round(v + 0.0, 4)


def _on_segment(p, a, b, eps=1e-3) -> bool:
    (px, py), (ax, ay), (bx, by) = p, a, b
    if abs((bx - ax) * (py - ay) - (by - ay) * (px - ax)) > eps * max(1.0, math.hypot(bx - ax, by - ay)):
        return False
    return min(ax, bx) - eps <= px <= max(ax, bx) + eps and min(ay, by) - eps <= py <= max(ay, by) + eps


def _same(p, q, eps=1e-3) -> bool:
    return abs(p[0] - q[0]) < eps and abs(p[1] - q[1]) < eps


def _overlap(a, b, c, d, eps=1e-3) -> bool:
    """Two segments lie along the same line and share more than a point."""
    if not (_on_line(c, a, b, eps) and _on_line(d, a, b, eps)):
        return False
    k = 0 if abs(b[0] - a[0]) >= abs(b[1] - a[1]) else 1
    lo, hi = sorted((a[k], b[k]))
    lo2, hi2 = sorted((c[k], d[k]))
    return min(hi, hi2) - max(lo, lo2) > eps


def _on_line(p, a, b, eps=1e-3) -> bool:
    return abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) <= eps * max(1.0, math.hypot(b[0] - a[0], b[1] - a[1]))


def _simplify(pts):
    out = []
    for p in pts:
        p = (_r(p[0]), _r(p[1]))
        if out and _same(out[-1], p):
            continue
        if len(out) >= 2 and _on_line(p, out[-2], out[-1]) and _on_segment(out[-1], out[-2], p):
            out[-1] = p
            continue
        out.append(p)
    return out


class Pin(dict):
    """One pin of a placed symbol: number, name, type, x, y, side, net."""

    @property
    def at(self):
        return (self["x"], self["y"])

    def __repr__(self):
        return f"{self['ref']}.{self['number']}({self['name']}) at {self.at} net {self['net'] or '-'}"


class Project:
    """A design: its schematic sheets and its board."""

    def __init__(self, transport: Transport):
        self.transport = transport
        info = getattr(transport, "documents", None) or transport.call("documents")
        self.name = info.get("project", "")
        self._docs = info.get("documents", [])
        self._open: dict = {}
        self.log: list = []
        self.footprints: dict = {}   # generated footprints by id, handed to the board when it syncs
        self.custom_power: dict = {}  # power symbols made for supply names KiCad's power library does not have: name -> symbol text
        self.net_pins: dict = {}     # net name given to build -> one of its pins, for nets that carry no label on the sheet

    # ---- documents
    def documents(self) -> list:
        return [d["path"] for d in self._docs]

    def schematic(self, name: str | None = None) -> "Schematic":
        return self._doc(name, "schematic")

    sheet = schematic

    def board(self) -> "Board":
        return self._doc(None, "board")

    def _doc(self, name, kind):
        hits = [d for d in self._docs if d["type"] == kind and (not name or name.lower() in (d["path"].lower(), d["path"].lower().rsplit("/", 1)[-1], re.sub(r"\.kicad_\w+$", "", d["path"].lower().rsplit("/", 1)[-1])))]
        if not hits:
            raise HarnessError(f"This project has no {kind}{' named ' + name if name else ''}. Its documents are: {', '.join(self.documents()) or 'none'}.")
        path = hits[0]["path"]
        if path not in self._open:
            self._open[path] = (Schematic if kind == "schematic" else Board)(self, path)
        return self._open[path]

    # ---- life cycle
    def commit(self) -> None:
        """Send every queued edit to the engine."""
        for d in self._open.values():
            d.flush()

    def save(self) -> list:
        """Commit, then write changed files back (local projects; an online project is always saved)."""
        self.commit()
        return self.transport.save()

    def close(self) -> None:
        self.transport.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self.save()
        finally:
            self.close()

    def note(self, text: str) -> None:
        self.log.append(text)

    def summary(self) -> str:
        return "\n".join(self.log)


class _Doc:
    def __init__(self, project: Project, path: str):
        self.project = project
        self.path = path
        self._q: list = []
        self._keys: set = set()
        self._geom = None

    # ---- engine calls
    def _call(self, tool: str, **args):
        self.flush()
        args["document"] = self.path
        return self.project.transport.call(tool, args)

    def _edit(self, edit: dict, key: str | None = None) -> None:
        """Queue one edit.  Two edits of the same item cannot share a batch, so the queue is sent first."""
        if key is not None:
            if key in self._keys:
                self.flush()
            self._keys.add(key)
        self._q.append(edit)
        if len(self._q) >= 300:
            self.flush()

    def flush(self) -> dict | None:
        if not self._q:
            return None
        edits, self._q, self._keys, self._geom = self._q, [], set(), None
        res = self.project.transport.call("apply", {"document": self.path, "edits": edits})
        for line in res.get("connectivity") or []:
            self._connectivity.append(line)
        self._last = res
        return res

    _connectivity: list = []
    _last: dict | None = None

    def geometry(self) -> dict:
        self.flush()
        if self._geom is None:
            self._geom = self._call("get_geometry")
        return self._geom

    def check(self, limit: int = 6, kind: str | None = None, warnings: bool = False) -> dict:
        """Run the rules check (ERC on a sheet, DRC on the board): counts by kind and the first few violations, errors first.
        `kind` lists only that kind ("unconnected_items", "clearance"); `warnings=True` lists warnings after the errors."""
        r = self._call("run_checks")
        kinds, wkinds = {}, {}
        for v in r.get("violations", []):
            d = kinds if v["severity"] == "error" else wkinds
            d[v["code"]] = d.get(v["code"], 0) + 1
        rows = [v for v in r.get("violations", []) if (v["code"] == kind if kind else v["severity"] == "error" or warnings)]
        rows.sort(key=lambda v: v["severity"] != "error")
        first = [f"{v['severity']} {v['code']}: {v['message']}" + (f" [{', '.join(v['refs'])}]" if v.get("refs") else "") + f" at ({v['x']}, {v['y']})" for v in rows[:limit]]
        out = {"check": r.get("check"), "errors": r.get("errors", 0), "warnings": r.get("warnings", 0), "by_kind": kinds, "first": first}
        if warnings or kind:
            out["warnings_by_kind"] = wkinds
        return out

    def clear(self, keep: tuple = ()) -> int:
        """Take everything off this sheet or board, for a rebuild from nothing.  `keep` names kinds of item to leave
        (on a board the outline stays unless outline=False is given to Board.clear).  Returns how many items were removed."""
        self.flush()
        count, skip = 0, set()
        for _ in range(400):   # get_items answers in pages: take a page off, ask again
            got = self._call("get_items", near={"x": 0, "y": 0, "radius": 1e7})
            todo = [it for it in got.get("items", []) if it["id"] not in skip]
            for it in todo:
                if it.get("kind") in keep or self._kept(it):
                    skip.add(it["id"])
                    continue
                self._edit({"op": "remove", "id": it["id"]})
                count += 1
            self.flush()
            if not todo or not any(it["id"] not in skip for it in todo):
                break
        if count:
            self.project.note(f"{getattr(self, 'path', None) or 'board'}: cleared {count} items")
        return count

    def _kept(self, it: dict) -> bool:
        return False

    def remove(self, *refs: str) -> None:
        for ref in refs:
            self._edit({"op": "remove", "ref": ref} if not re.fullmatch(r"[0-9a-f-]{36}", ref) else {"op": "remove", "id": ref}, "item:" + ref)

    def set(self, ref: str, **fields) -> None:
        """Set fields of a part: value=, footprint=, datasheet=, or any field name."""
        for name, value in fields.items():
            self._edit({"op": "set_field", "ref": ref, "field": {"value": "Value", "footprint": "Footprint", "datasheet": "Datasheet", "reference": "Reference"}.get(name, name), "value": str(value)}, "item:" + ref)
            self.flush()   # one item may take several fields: each is its own batch

    def text(self, text: str, at, size: float | None = None, bold: bool = False, italic: bool = False) -> None:
        """Free text; `at` is its bottom left.  On a sheet `size` is the height in mm (1.27 by default) and `bold` makes a heading."""
        e = {"op": "add_text", "text": text, "x": _r(at[0]), "y": _r(at[1])}
        if size:
            e["size"] = size
        if bold:
            e["bold"] = True
        if italic:
            e["italic"] = True
        self._edit(e)

    def svg(self, path: str | None = None, box=None) -> str:
        """The sheet or the board as an SVG drawing, the way the editor shows it (local projects).  Written to `path` when given."""
        r = self._call("render", **({"box": list(box)} if box else {}))
        if path:
            with open(path, "w", encoding="utf-8") as f:
                f.write(r["svg"])
        return r["svg"]

    def add_item(self, sexpr: str) -> None:
        """Escape hatch for an item the other calls do not cover: one complete KiCad s-expression."""
        self._edit({"op": "add_item", "sexpr": sexpr})


class Schematic(_Doc):
    """One schematic sheet."""

    def __init__(self, project, path):
        super().__init__(project, path)
        self._facts: dict = {}
        self._connectivity = []
        self._auto_net = 0

    # ---- reading
    def parts(self, include_power: bool = False) -> list:
        """The parts on the sheet as short rows: ref, value, lib_id, x, y, rotation."""
        return [{k: p[k] for k in ("ref", "value", "lib_id", "x", "y", "rotation")} for p in self.geometry()["parts"] if include_power or not p.get("power")]

    def refs(self) -> list:
        return sorted({p["ref"] for p in self.geometry()["parts"] if not p.get("power")}, key=_ref_key)

    def pins(self, ref: str) -> list:
        """The pins of a part, each with its position and net."""
        out = []
        for p in self.geometry()["parts"]:
            if p["ref"].lower() == ref.lower():
                out += [Pin(ref=p["ref"], number=q[0], name=q[1], type=q[2], x=q[3], y=q[4], side=q[5], net=q[6], hidden=bool(q[7])) for q in p["pins"]]
        if not out:
            raise HarnessError(f"There is no part {ref} on {self.path}.")
        return out

    def pin(self, spec: str) -> Pin:
        """One pin by "REF.number" or "REF.name" (for example "U1.3" or "U1.VBUS")."""
        return self._pins(spec)[0]

    def _pins(self, spec) -> list:
        if isinstance(spec, Pin):
            return [spec]
        ref, _, which = str(spec).partition(".")
        if not which:
            raise HarnessError(f'A pin is written "REF.number" or "REF.name"; got "{spec}".')
        pins = self.pins(ref)
        bare = lambda n: re.sub(r"~\{(.*?)\}", r"\1", n).lower()   # an inverted pin is written ~{RST} in the library
        hit = [p for p in pins if p["number"] == which] or [p for p in pins if p["name"].lower() == which.lower()] or [p for p in pins if bare(p["name"]) == bare(which)]
        if not hit:
            raise HarnessError(f"{ref} has no pin {which}. Its pins are: " + ", ".join(f"{p['number']}={p['name']}" if p["name"] else p["number"] for p in pins[:80]))
        return hit

    def nets(self, filter: str | None = None) -> dict:
        """The nets of the sheet: name -> ["REF.pin", ...]."""
        r = self._call("list_nets", **({"filter": filter} if filter else {}))
        return {n["name"]: [re.sub(r"\(.*\)$", "", p) for p in n["pins"]] for n in r.get("nets", [])}

    def net_of(self, spec: str) -> str:
        return self.pin(spec)["net"]

    def unconnected(self) -> list:
        """Pins that are on no net and carry no no-connect flag."""
        g = self.geometry()
        nc = [tuple(p) for p in g.get("no_connects", [])]
        counts: dict = {}
        for p in g["parts"]:
            for q in p["pins"]:
                counts[q[6]] = counts.get(q[6], 0) + 1
        out = []
        for p in g["parts"]:
            if p.get("power"):
                continue
            for q in p["pins"]:
                lone = not q[6] or (counts.get(q[6], 0) < 2 and (q[6].startswith("Net-(") or q[6].startswith("unconnected-")))
                if lone and not q[7] and not any(_same((q[3], q[4]), n) for n in nc) and not self._has_label_at((q[3], q[4]), g):
                    out.append(f"{p['ref']}.{q[0]}" + (f"({q[1]})" if q[1] else ""))
        return out

    def _has_label_at(self, pt, g) -> bool:
        ends = [(w[0], w[1]) for w in g["wires"]] + [(w[2], w[3]) for w in g["wires"]]
        return any(_same(pt, (l[1], l[2])) for l in g["labels"]) or any(_same(pt, e) for e in ends)

    # ---- library
    def lib(self, lib_id) -> dict:
        """Facts of a library symbol before it is placed: reference prefix, pins with offsets, body box."""
        if hasattr(lib_id, "facts"):
            return lib_id.facts()
        if lib_id not in self._facts:
            self._facts[lib_id] = self.project.transport.call("get_library_part", {"id": lib_id})
        return self._facts[lib_id]

    # ---- placing
    def place(self, lib, at=None, ref: str | None = None, value: str | None = None, footprint: str | None = None,
              rotation: int = 0, mirror: str | None = None, fields: dict | None = None, unit: int | None = None) -> str:
        """Place a symbol and return its reference.

        `lib` is a KiCad library id ("Device:R"), a generated part (kicad_harness.parts) or a vendor
        part as {"vendor": "lcsc", "id": "C25744"}.  Without `at` a free spot on the sheet is found.
        """
        e: dict = {"op": "add_symbol", "rotation": rotation % 360}
        f = dict(fields or {})
        if hasattr(lib, "symbol"):   # a generated part carries its own drawing and footprint
            e["symbol"] = lib.symbol
            e["lib_id"] = lib.lib_id
            f = {**lib.fields(), **f}
            if lib.footprint_id and lib.footprint:
                self.project.footprints[lib.footprint_id] = lib.footprint
        elif isinstance(lib, dict):
            e["part"] = lib
        else:
            e["lib_id"] = lib
        if footprint:
            f["Footprint"] = footprint
        if f:
            e["fields"] = f
        if value is not None:
            e["value"] = str(value)
        if mirror:
            e["mirror"] = mirror
        if unit:
            e["unit"] = unit
        if ref:
            e["reference"] = ref
        if at is None:
            at = self._free_spot(lib if not isinstance(lib, dict) else None, rotation)
        e["x"], e["y"] = _snap(at[0]), _snap(at[1])
        self._edit(e)
        if ref:
            return ref
        res = self.flush() or {}
        m = re.match(r"Add (\S+)", (res.get("edits") or [""])[-1])
        return m.group(1) if m else ""

    def _box(self, lib, rotation=0):
        try:
            b = (self.lib(lib)["units"][0].get("body_box")) if lib is not None else None
        except HarnessError:
            b = None
        b = b or [-5.08, -5.08, 5.08, 5.08]
        if rotation % 180:
            b = [b[1], b[0], b[3], b[2]]
        return b

    def _free_spot(self, lib, rotation=0, margin=7.62):
        self.flush()
        g = self.geometry()
        b = self._box(lib, rotation)
        page = g.get("page") or [297, 210]
        boxes = [p["box"] for p in g["parts"] if p.get("box")]
        x0, y0 = 25.4 - b[0], 25.4 - b[1]
        y = y0
        while y < max(page[1] - 30, y0 + 1) * 3:
            x = x0
            while x + b[2] < page[0] - 20:
                rect = (x + b[0] - margin, y + b[1] - margin, x + b[2] + margin, y + b[3] + margin)
                if not any(rect[0] < o[2] and rect[2] > o[0] and rect[1] < o[3] and rect[3] > o[1] for o in boxes):
                    return (_snap(x, 2.54), _snap(y, 2.54))
                x += 5.08
            y += 5.08
        return (x0, y0)

    def move(self, ref: str, to=None, by=None, rotation: int | None = None) -> None:
        """Move a part to a point, or by an offset; its wires are not dragged along."""
        if to is None:
            p = next((q for q in self.geometry()["parts"] if q["ref"].lower() == ref.lower()), None)
            if not p:
                raise HarnessError(f"There is no part {ref} on {self.path}.")
            to = (p["x"] + (by[0] if by else 0), p["y"] + (by[1] if by else 0))
        e = {"op": "move", "ref": ref, "x": _snap(to[0]), "y": _snap(to[1])}
        if rotation is not None:
            e["rotation"] = rotation % 360
        self._edit(e, "item:" + ref)

    def rotate(self, ref: str, rotation: int) -> None:
        """Turn a part to an absolute rotation (0, 90, 180 or 270, counter-clockwise)."""
        p = next((q for q in self.geometry()["parts"] if q["ref"].lower() == ref.lower()), None)
        if not p:
            raise HarnessError(f"There is no part {ref} on {self.path}.")
        self._edit({"op": "move", "ref": ref, "x": p["x"], "y": p["y"], "rotation": rotation % 360}, "item:" + ref)

    # ---- wiring
    def wire(self, *points) -> None:
        """A wire through explicit points; pins may be given as "REF.pin"."""
        pts = [list(self.pin(p).at) if isinstance(p, (str, Pin)) else [_r(p[0]), _r(p[1])] for p in points]
        self._edit({"op": "add_wire", "points": pts})

    def junction(self, at) -> None:
        self._edit({"op": "add_junction", "x": at[0], "y": at[1]})

    def no_connect(self, *pins) -> None:
        """Mark pins as deliberately unconnected."""
        for spec in pins:
            for p in self._pins(spec):
                self._edit({"op": "add_no_connect", "x": p["x"], "y": p["y"]})

    def _blocked(self, path, g, ends) -> bool:
        """Would a wire along `path` touch something it is not meant to connect to?"""
        segs = list(zip(path, path[1:]))
        for p in g["parts"]:
            for q in p["pins"]:
                pt = (q[3], q[4])
                if any(_same(pt, e) for e in ends):
                    continue
                if any(_on_segment(pt, a, b) for a, b in segs):
                    return True
        pts = [(w[0], w[1]) for w in g["wires"]] + [(w[2], w[3]) for w in g["wires"]] + [(l[1], l[2]) for l in g["labels"]] + [tuple(j) for j in g["junctions"]]
        for pt in pts:
            if any(_same(pt, e) for e in ends):
                continue
            if any(_on_segment(pt, a, b) for a, b in segs):
                return True
        for w in g["wires"]:
            c, d = (w[0], w[1]), (w[2], w[3])
            for a, b in segs:
                if _overlap(a, b, c, d):
                    return True
                for v in path[1:-1]:
                    if _on_segment(v, c, d):
                        return True
        return False

    def _crossings(self, path, g) -> int:
        n = 0
        for a, b in zip(path, path[1:]):
            lo = (min(a[0], b[0]), min(a[1], b[1]))
            hi = (max(a[0], b[0]), max(a[1], b[1]))
            for p in g["parts"]:
                o = p.get("box")
                if o and lo[0] < o[2] - 0.6 and hi[0] > o[0] + 0.6 and lo[1] < o[3] - 0.6 and hi[1] > o[1] + 0.6:
                    n += 1
        return n

    def _taps(self, p: Pin, g):
        """Where a wire to this pin may start: the pin itself, or the middle of a wire already on it (a T with a junction)."""
        out = [(p.at, _DIR[p["side"]], False)]
        for w in g["wires"]:
            c, d = (w[0], w[1]), (w[2], w[3])
            if not (_same(c, p.at) or _same(d, p.at)) or math.hypot(d[0] - c[0], d[1] - c[1]) < 2 * GRID - 1e-6:
                continue
            horizontal = abs(d[1] - c[1]) < 1e-6
            m = (_snap((c[0] + d[0]) / 2), c[1]) if horizontal else (c[0], _snap((c[1] + d[1]) / 2))
            if _same(m, c) or _same(m, d):
                continue
            for dv in (((0, -1), (0, 1)) if horizontal else ((-1, 0), (1, 0))):
                out.append((m, dv, True))
        return out

    def _route(self, a: Pin, b: Pin, g):
        best = None
        for pa, da, ja in self._taps(a, g):
            for pb, db, jb in self._taps(b, g):
                cands = []
                for sa in (STUB, 2 * STUB, 0):
                    for sb in (STUB, 2 * STUB, 0):
                        ea = (pa[0] + da[0] * sa, pa[1] + da[1] * sa)
                        eb = (pb[0] + db[0] * sb, pb[1] + db[1] * sb)
                        for corner in ((ea[0], eb[1]), (eb[0], ea[1])):
                            cands.append(_simplify([pa, ea, corner, eb, pb]))
                        for t in (0.5, 0.25, 0.75):
                            mx = _snap(ea[0] + (eb[0] - ea[0]) * t)
                            my = _snap(ea[1] + (eb[1] - ea[1]) * t)
                            cands.append(_simplify([pa, ea, (mx, ea[1]), (mx, eb[1]), eb, pb]))
                            cands.append(_simplify([pa, ea, (ea[0], my), (eb[0], my), eb, pb]))
                for path in cands:
                    if len(path) < 2 or any(abs(p[0] - q[0]) > 1e-3 and abs(p[1] - q[1]) > 1e-3 for p, q in zip(path, path[1:])):
                        continue
                    # a wire must leave a pin away from its symbol, not back through the body
                    if (path[1][0] - pa[0]) * da[0] + (path[1][1] - pa[1]) * da[1] < 1e-6 or (path[-2][0] - pb[0]) * db[0] + (path[-2][1] - pb[1]) * db[1] < 1e-6:
                        if not (len(path) == 2 and (path[1][0] - pa[0]) * da[0] + (path[1][1] - pa[1]) * da[1] > 1e-6):
                            continue
                    if self._blocked(path, g, (pa, pb)):
                        continue
                    cost = sum(abs(p[0] - q[0]) + abs(p[1] - q[1]) for p, q in zip(path, path[1:])) + 4 * len(path) + 40 * self._crossings(path, g) + 6 * (ja + jb)
                    if best is None or cost < best[0]:
                        best = (cost, path, [pt for pt, j in ((pa, ja), (pb, jb)) if j])
        return (best[1], best[2]) if best and best[0] < 400 else None

    def connect(self, *pins, net: str | None = None) -> str:
        """Connect pins to one another: a drawn wire where a clean one fits, net labels where it does not.

        Returns how each connection was made.  `net` names the net (a label is added).
        """
        specs = [self._pins(p)[0] for p in pins]
        if len(specs) < 2:
            raise HarnessError("connect needs at least two pins.")
        how = []
        for a, b in zip(specs, specs[1:]):
            self.flush()
            g = self.geometry()
            a, b = self.pin(f"{a['ref']}.{a['number']}"), self.pin(f"{b['ref']}.{b['number']}")
            if a["net"] and a["net"] == b["net"] and not a["net"].startswith(("Net-(", "unconnected-")):
                how.append("already")
                continue
            found = self._route(a, b, g)
            if found:
                self._edit({"op": "add_wire", "points": [list(p) for p in found[0]]})
                for j in found[1]:
                    self.junction(j)
                how.append("wire")
            else:
                name = net or next((p["net"] for p in (a, b) if p["net"] and not p["net"].startswith(("Net-(", "unconnected-"))), None) or self._new_net(a)
                self.label(a, name)
                self.label(b, name)
                how.append(f"labels {name}")
        if net:
            self.flush()
            if self.pin(f"{specs[0]['ref']}.{specs[0]['number']}")["net"] != net:
                self.label(specs[0], net)
        self.flush()
        return ", ".join(how)

    def _new_net(self, a: Pin) -> str:
        return f"{a['ref']}_{a['name'] or a['number']}".replace(" ", "_").replace("/", "_")

    def _stub(self, p: Pin, g, length=STUB):
        d = _DIR[p["side"]]
        end = (_r(p["x"] + d[0] * length), _r(p["y"] + d[1] * length))
        if self._blocked([p.at, end], g, (p.at,)):
            return None
        return end

    def label(self, pin, name: str, kind: str = "label") -> None:
        """Put a net label on a pin (on a short stub away from the symbol).  `pin` may name several pins ("U1.GND")."""
        for p in self._pins(pin):
            self.flush()
            g = self.geometry()
            if any(_same(p.at, (l[1], l[2])) and l[0] == name for l in g["labels"]) or (p["net"] == name and not p.get("hidden")):
                continue
            end = self._stub(p, g)
            if end:
                self._edit({"op": "add_wire", "points": [list(p.at), list(end)]})
            at = end or p.at
            if kind == "label" and p["side"] in ("left", "right"):
                # the wire runs on under the whole name: the label sits on the wire's far end and lies back over it
                w = math.ceil((self._width(name) + 0.6) / 1.27) * 1.27
                far = (_r(at[0] + (w if p["side"] == "right" else -w)), at[1])
                if not self._blocked([at, far], g, (at,)):
                    self._edit({"op": "add_wire", "points": [list(at), list(far)]})
                    self._edit({"op": "add_label", "kind": kind, "text": name, "x": far[0], "y": far[1], "rotation": 180 if p["side"] == "right" else 0})
                    continue
            self._edit({"op": "add_label", "kind": kind, "text": name, "x": at[0], "y": at[1], "rotation": _LABEL_ROT[p["side"]]})

    def power(self, pin, name: str) -> None:
        """Put a power symbol (power:GND, power:+3V3, ...) on a pin.  `pin` may name several pins ("U1.GND")."""
        lib_id = name if ":" in name else "power:" + name
        short = lib_id.split(":", 1)[1]
        for p in self._pins(pin):
            self.flush()
            g = self.geometry()
            if p["net"] == short:
                continue
            end = self._stub(p, g)
            at = end or p.at
            if end:
                self._edit({"op": "add_wire", "points": [list(p.at), list(end)]})
            rot = (_GND_ROT if _GROUND.search(short) else _SUPPLY_ROT)[p["side"]]
            self._is_power(short)
            self._edit(self._power_edit(lib_id, at[0], at[1], rot))

    def _is_power(self, name: str) -> bool:
        if name in self.project.custom_power:
            return True
        if not _POWER.match(name) and not (_SUPPLY.match(name) and not _NOT_SUPPLY.search(name)):
            return False
        try:
            return bool(self.lib("power:" + name).get("power_symbol", True))
        except HarnessError:
            self.supply(name)        # a supply KiCad's power library has no symbol for: one is made, as a person would
            return True

    def supply(self, name: str) -> str:
        """Declare a net a supply (or a ground) that KiCad's power library has no symbol for ("VSYS", "VDD_SPI", "GND_RF"):
        from then on it is drawn with a power symbol of its own, an arrow up for a supply and KiCad's ground mark for a
        ground, instead of a net label.  `net`, `power` and `build` do this by themselves for names that read as supplies."""
        if name not in self.project.custom_power:
            ground = bool(_GROUND.search(name))
            self.project.custom_power[name] = _power_symbol(name, ground)
            self._facts["power:" + name] = {"lib_id": "power:" + name, "power_symbol": True, "reference_prefix": "#PWR", "value": name,
                                            "units": [{"unit": 1, "body_box": [-1.27, 0, 1.27, 2.54] if ground else [-0.762, -2.54, 0.762, 0],
                                                       "pins": [{"number": "1", "name": "~", "type": "power_in", "dx": 0, "dy": 0}]}]}
        return name

    def _power_edit(self, name: str, x, y, rotation=0) -> dict:
        """The edit that places a power symbol, carrying the symbol's drawing when it is one of our own."""
        short = name.split(":", 1)[-1]
        e = {"op": "add_symbol", "lib_id": name if ":" in name else "power:" + name, "x": x, "y": y, "rotation": rotation}
        if short in self.project.custom_power:
            e["symbol"] = self.project.custom_power[short]
        return e

    def net(self, name: str, *pins) -> None:
        """Put pins on a named net: a power symbol when KiCad has one of that name (GND, +3V3, VBUS), else a label."""
        power = self._is_power(name)
        for spec in pins:
            (self.power if power else self.label)(spec, name)

    def attach(self, pin, lib, value: str | None = None, footprint: str | None = None, ref: str | None = None,
               to: str | None = None, part_pin: str = "1", gap: float = 2 * STUB, fields: dict | None = None) -> str:
        """Place a two-pin part in line with a pin and wire it on, the way a series resistor or a decoupling
        capacitor is drawn.  `to` names the net of the part's far pin (a power symbol or a label).  Returns the reference.
        """
        p = self._pins(pin)[0]
        facts = self.lib(lib)
        lp = facts["units"][0]["pins"]
        mine = next((q for q in lp if q["number"] == str(part_pin)), lp[0])
        other = next((q for q in lp if q is not mine), mine)
        d = _DIR[p["side"]]
        rot = 0
        for r in (0, 90, 180, 270):
            ox, oy = _rot(other["dx"] - mine["dx"], other["dy"] - mine["dy"], r)
            if ox * d[0] + oy * d[1] > 0.5 * math.hypot(ox, oy):
                rot = r
                break
        mx, my = _rot(mine["dx"], mine["dy"], rot)
        start = (p["x"] + d[0] * gap, p["y"] + d[1] * gap)
        at = (_r(start[0] - mx), _r(start[1] - my))
        new = self.place(lib, at=at, ref=ref, value=value, footprint=footprint, rotation=rot, fields=fields)
        self.flush()
        g = self.geometry()
        q = self.pin(f"{new}.{mine['number']}")
        if not self._blocked([p.at, q.at], g, (p.at, q.at)) and (_same(p.at, q.at) is False):
            self._edit({"op": "add_wire", "points": [list(p.at), list(q.at)]})
        else:
            self.connect(p, q)
        if to and other is not mine:
            self.net(to, f"{new}.{other['number']}")
        self.flush()
        return new

    def decouple(self, pin, value: str = "100nF", gnd: str = "GND", footprint: str = "Capacitor_SMD:C_0402_1005Metric", lib: str = "Device:C") -> list:
        """A decoupling capacitor for each supply pin named: one side on the pin's net, the other on ground.
        The capacitors go in a free row of the sheet with power symbols or labels, not on the pin's own wire.
        """
        out = []
        for p in self._pins(pin):
            name = p["net"]
            if not name or name.startswith(("Net-(", "unconnected-")):
                raise HarnessError(f"{p['ref']}.{p['number']} is not on a named net yet; put it on its supply first (net or power).")
            c = self.place(lib, value=value, footprint=footprint)
            self.net(name, f"{c}.1")
            self.net(gnd, f"{c}.2")
            out.append(c)
        self.flush()
        return out

    # ---- how the sheet reads: overlaps, frames, notes
    def layout(self, within=None, of=None, wrap=None, limit: int = 40) -> dict:
        """The sheet's layout check: overlaps (what, a, b, x, y), counts by kind, the extent of what is drawn
        (or of the items inside `within`, or of the parts `of` with what hangs on their pins), the usable drawing
        area and the title block.  `wrap` breaks notes into lines: [{"text", "size", "width"}]."""
        args: dict = {"limit": limit}
        if within:
            args["within"] = [_r(v) for v in within]
        if of:
            args["of"] = list(of)
        if wrap:
            args["wrap"] = wrap
        return self._call("check_layout", **args)

    def sections(self) -> list:
        """The framed sections on the sheet: [{"title", "box", "parts"}], top to bottom."""
        self.flush()
        return self.layout(limit=1).get("sections", [])

    def overlaps(self, limit: int = 40) -> list:
        """Everything drawn on top of something else, or off the page, as short lines.  An empty list is a clean sheet."""
        r = self.layout(limit=limit)
        out = [f"{o['what']}: {o['a']} / {o['b']} at ({o['x']}, {o['y']})" for o in r.get("overlaps", [])]
        if r.get("count", 0) > len(out):
            out.append(f"... and {r['count'] - len(out)} more")
        return out

    def autoplace_fields(self, *refs: str) -> None:
        """KiCad's Autoplace Fields for these parts (all parts without arguments): reference and value beside the body, clear of what is around."""
        self.flush()
        self._edit({"op": "autoplace_fields", **({"refs": list(refs)} if refs else {})})
        self.flush()
        self._edit({"op": "clear_fields", **({"refs": list(refs)} if refs else {})})   # a value that landed on a pin's label
        self.flush()

    def tidy(self) -> dict:
        """Move any reference or value that is drawn over something to the nearest clear spot, then report what still overlaps:
        {"overlaps": n, "by_kind": {...}, "first": [...]}.  Fields that are already clear stay where they are, so a sheet drawn
        by build() keeps its look; autoplace_fields() is the call that puts every field back beside its part."""
        self.flush()
        self._edit({"op": "clear_fields"})
        self.flush()
        r = self.layout(limit=12)
        return {"overlaps": r.get("count", 0), "by_kind": r.get("by_kind", {}), "first": [f"{o['what']}: {o['a']} / {o['b']} at ({o['x']}, {o['y']})" for o in r.get("overlaps", [])]}

    def page(self, paper: str) -> None:
        """Set the page size: "A4", "A3", "A2", "A1", "A0" (or the US sizes)."""
        self._edit({"op": "set_page", "paper": paper})
        self.flush()

    def title(self, title: str | None = None, rev: str | None = None, date: str | None = None, company: str | None = None) -> None:
        """Fill in the sheet's title block (File, Page Settings): title, revision, date, company.  Lines not given stay as they are."""
        e = {k: v for k, v in (("title", title), ("rev", rev), ("date", date), ("company", company)) if v is not None}
        if e:
            self.flush()
            self._edit({"op": "set_page", **e})
            self.flush()

    def frame(self, box, title: str | None = None, notes=None, style: str = "dash") -> list:
        """Draw a frame with a heading inside its top left corner and notes along its bottom.  `box` is [x0, y0, x1, y1]
        around the content; the frame is drawn with room for the heading above and the notes below.  Returns the frame's box."""
        lines = self._note_lines(notes, max(box[2] - box[0], 60.0) - 2 * _PAD)
        tw = self.layout(wrap=[{"text": title, "size": _TITLE, "width": 1e6}])["wrapped"][0]["width"] if title else 0
        nw = max([w for _, w in lines] + [0])
        x0, y0 = box[0] - _PAD, box[1] - _PAD - (_HEAD if title else 0)
        x1 = max(box[2] + _PAD, x0 + tw * 1.08 + 2 * _PAD, x0 + nw + 2 * _PAD)
        y1 = box[3] + _PAD + (len(lines) * _LINE + _PAD if lines else 0)
        self._edit({"op": "add_rectangle", "x0": _r(x0), "y0": _r(y0), "x1": _r(x1), "y1": _r(y1), "style": style})
        if title:
            self.text(title, (x0 + _PAD / 2 + 0.6, y0 + _HEAD - 1.4), size=_TITLE, bold=True)
        y = box[3] + _PAD + _LINE
        for line, _ in lines:
            self.text(line, (x0 + _PAD, y), italic=True)
            y += _LINE
        self.flush()
        return [_r(x0), _r(y0), _r(x1), _r(y1)]

    def _note_lines(self, notes, width: float) -> list:
        notes = [notes] if isinstance(notes, str) else list(notes or [])
        if not notes:
            return []
        got = self.layout(wrap=[{"text": ("" if n.lower().startswith("note") else "Note: ") + n, "size": 1.27, "width": width} for n in notes])["wrapped"]
        out = []
        for w in got:
            for i, line in enumerate(w["lines"]):
                out.append((line if i == 0 else "  " + line, w["width"] + (1.5 if i else 0)))
        return out

    def section(self, title: str, refs: list, notes=None) -> list:
        """Frame the parts of one functional block, with a heading and optional notes that say why something is unusual.
        The frame goes around the parts and everything on their pins (stubs, labels, power symbols).  Returns the frame's box;
        run overlaps() afterwards, since a frame drawn around parts that sit among others can cut through a neighbour."""
        self.flush()
        ext = self.layout(of=refs).get("extent")
        if not ext:
            raise HarnessError("None of those parts is on the sheet: " + ", ".join(refs))
        return self.frame(ext, title, notes)

    def note(self, text: str, near: str | None = None, at=None, width: float = 60.0) -> list:
        """A note on the sheet, for a design choice somebody reading it would not expect.  With `near` (a reference) it is put
        in the closest free space beside that part; with `at` exactly there (top left).  Returns where it went."""
        self.flush()
        lines = self._note_lines(text, width)
        w, h = max(x for _, x in lines) + 1.0, len(lines) * _LINE + 0.6
        if at is None:
            spot = self._call("check_layout", limit=1, free={"near": near, "w": _r(w), "h": _r(h)} if near else {"w": _r(w), "h": _r(h)}).get("free")
            if not spot:
                raise HarnessError("There is no free space for that note on the page; make the page larger with page(\"A3\") or give at=(x, y).")
            at = (spot["x"], spot["y"])
        y = at[1] + _LINE - 0.4
        for line, _ in lines:
            self.text(line, (at[0] + 0.5, y), italic=True)
            y += _LINE
        self.flush()
        return [_r(at[0]), _r(at[1])]

    # ---- room: how much space a part takes once its pins carry stubs, labels and power symbols
    def _width(self, *names) -> float:
        """The drawn width of these texts at the default size (the widest of them)."""
        tws = self.__dict__.setdefault("_tws", {})
        missing = [n for n in dict.fromkeys(names) if n and n not in tws]
        if missing:
            got = self.layout(wrap=[{"text": n, "size": 1.27, "width": 1e6} for n in missing], limit=1)["wrapped"]
            for n, w in zip(missing, got):
                tws[n] = w["width"]
        return max([tws[n] for n in names if n] + [0.0])

    def _lib_pins(self, lib, rotation=0):
        """A library part's body box and pins at this rotation, relative to the symbol's position: (box, [(number, name, x, y, side)])."""
        try:
            unit = self.lib(lib)["units"][0] if lib is not None and not isinstance(lib, dict) else None
        except HarnessError:
            unit = None
        b0 = (unit or {}).get("body_box") or [-5.08, -5.08, 5.08, 5.08]
        cs = [_rot(x, y, rotation) for x in (b0[0], b0[2]) for y in (b0[1], b0[3])]
        box = [min(c[0] for c in cs), min(c[1] for c in cs), max(c[0] for c in cs), max(c[1] for c in cs)]
        pins = []
        for q in (unit or {}).get("pins", []):
            x, y = _rot(q["dx"], q["dy"], rotation)
            d = {"left": x - box[0], "right": box[2] - x, "top": y - box[1], "bottom": box[3] - y}
            pins.append((q["number"], q.get("name", ""), x, y, min(d, key=d.get)))
        return box, pins

    def _room(self, ref, spec, intent) -> list:
        """The box a part will take, relative to its position: body, stubs, labels, power symbols and its own fields."""
        lib = spec.get("lib")
        box, pins = self._lib_pins(lib, spec.get("rotation", 0))
        out = [box[0] - 1.27, box[1] - 1.27, box[2] + 1.27, box[3] + 1.27]
        sides = set()
        for number, _, x, y, side in pins:
            name = intent.get((ref, number))
            if not name:
                continue
            sides.add(side)
            w = self._width(name)
            if self._is_power(name):
                along, across = (STUB + 5.5 + w + 1.5, 2.3) if side in ("left", "right") else (STUB + 7.0, max(2.8, w / 2 + 0.6))
            else:
                along, across = STUB + w + 2.0, 2.0
            dx, dy = _DIR[side]
            ex, ey = x + dx * along, y + dy * along
            out = [min(out[0], ex, x - (across if dy else 0)), min(out[1], ey, y - (across if dx else 0)),
                   max(out[2], ex, x + (across if dy else 0)), max(out[3], ey, y + (across if dx else 0))]
        fw = self._width(ref, str(spec.get("value") or "")) + 2.0
        if "right" not in sides:
            out[2] = max(out[2], box[2] + fw)
        elif "top" not in sides:
            out[1] = min(out[1], box[1] - 5.6)
            out[0], out[2] = min(out[0], -fw / 2), max(out[2], fw / 2)
        elif "bottom" not in sides:
            out[3] = max(out[3], box[3] + 5.6)
            out[0], out[2] = min(out[0], -fw / 2), max(out[2], fw / 2)
        else:
            out[1], out[3] = out[1] - 5.6, out[3] + 5.6
        return out

    def _intent(self, parts, nets) -> dict:
        """(ref, pin number) -> net name, from a netlist written by pin number or pin name."""
        out = {}
        cache = {}
        for name, specs in nets.items():
            for spec in specs:
                ref, _, which = str(spec).partition(".")
                p = parts.get(ref)
                if p is None:
                    continue
                lib = p.get("lib") if isinstance(p, dict) else p
                if ref not in cache:
                    try:
                        cache[ref] = self._lib_pins(lib)[1] if not isinstance(lib, dict) else []
                    except HarnessError:
                        cache[ref] = []
                bare = lambda n: re.sub(r"~\{(.*?)\}", r"\1", n).lower()
                pins = cache[ref]
                hit = [q for q in pins if q[0] == which] or [q for q in pins if q[1].lower() == which.lower()] or [q for q in pins if bare(q[1]) == bare(which)]
                for q in hit or [(which,)]:
                    out[(ref, q[0])] = name
        return out

    # ---- a whole sheet from a netlist
    def build(self, parts: dict, nets: dict, groups: dict | None = None, no_connect: list | None = None,
              notes: dict | None = None, frames: bool = True, labels: list | None = None, swap_pins: bool = True) -> dict:
        """Draw a schematic from a netlist in one call.

        parts: {ref: {"lib": "Device:R", "value": "10k", "footprint": "...", "fields": {...}}} (lib may be a
        generated part or a vendor part).  nets: {name: ["U1.3", "R1.1", ...]}.  groups: {"Block title": [refs]} is
        the sheet's organisation: each group is drawn as a framed section with its title, ICs at the left and their
        passives beside them.  notes: {"Block title": "why ..." or [..]} puts notes in that section; write one wherever
        a choice is not the standard one (an unusual value, a part left out, a pin tied off) so a reader knows why.
        Every pin gets a power symbol or a net label on a short stub, so the result is correct by construction.

        Blocks are drawn off the page, measured as drawn (fields, labels and all), and then packed onto the page, so
        nothing overlaps; the page grows (A4, A3, ...) when the design needs it.  Returns counts, anything that did
        not connect, and "overlaps": what the layout check still finds (0 for a clean sheet).
        """
        named = bool(groups)
        groups = dict(groups or {"main": list(parts)})
        seen = {r for rs in groups.values() for r in rs}
        rest = [r for r in parts if r not in seen]
        if rest:
            groups["Other"] = rest
        notes = dict(notes or {})
        for r, spec in parts.items():   # a note given with a part belongs to its block
            if isinstance(spec, dict) and spec.get("note"):
                g = next((n for n, rs in groups.items() if r in rs), None)
                if g:
                    notes[g] = ([notes[g]] if isinstance(notes.get(g), str) else list(notes.get(g) or [])) + [f"{r}: {spec['note']}"]
        self.flush()
        before = self.layout(limit=1)
        # ---- 1. every block off the page, drawn the way a datasheet draws its application circuit: wires inside the
        #         block, parts hanging on and in line with the wires of the IC pins, labels only where a net leaves it
        from .sheet import Blocks
        intent = self._intent(parts, nets)
        drawer = Blocks(self, parts, nets, groups, intent, _GROUND, arrange_pins=swap_pins)
        drawer.force |= set(labels or [])
        for (ref, num), name in intent.items():      # a net wired inside its block has no label: remember it by one of its pins
            self.project.net_pins.setdefault(name, f"{ref}.{num}")
        bands, placed, problems = drawer.run()
        # ---- 2. no-connect flags
        for spec in no_connect or []:
            try:
                self.no_connect(spec)
            except HarnessError as e:
                problems.append(str(e))
        self.flush()
        self._repair(nets)
        # ---- 3. measure each block as drawn, and what its heading and notes need
        blocks = []
        for gname, band in bands:
            ext = self.layout(within=band, limit=1).get("extent")
            if not ext:
                continue
            title = gname if named or gname == "Other" and len(groups) > 1 else None
            lines = self._note_lines(notes.get(gname), max(ext[2] - ext[0], 60.0) - _PAD) if frames else []
            tw = self.layout(wrap=[{"text": title, "size": _TITLE, "width": 1e6}], limit=1)["wrapped"][0]["width"] * 1.08 if title and frames else 0
            framed = frames and (title or lines)
            pad = _PAD if framed else 0
            w = max(ext[2] - ext[0] + 2 * pad, tw + 2 * pad + 1.2, max([lw for _, lw in lines] + [0]) + 2 * pad)
            h = ext[3] - ext[1] + 2 * pad + (_HEAD if title and frames else 0) + (len(lines) * _LINE + pad if lines else 0)
            blocks.append({"name": gname, "band": band, "ext": ext, "title": title if frames else None, "lines": lines, "w": w, "h": h, "framed": framed})
        # ---- 4. the smallest page they fit on, packed in rows in the order given
        used = before.get("extent")
        top = (used[3] + 7.62) if used else None
        # a sheet that was empty takes the smallest page the design fits on; one with drawing on it never shrinks
        papers = ([p for p in _PAPERS if p[1] >= (before.get("page") or [297, 210])[0] - 1] if used else list(_PAPERS)) or [_PAPERS[-1]]
        spots, paper = None, papers[-1]
        orders = [blocks, sorted(blocks, key=lambda b: -b["h"]), sorted(blocks, key=lambda b: -b["w"] * b["h"]), sorted(blocks, key=lambda b: -b["w"])]
        rng = random.Random(1)      # then a fixed set of other orders: packing is cheap, a page size too large is half an empty sheet
        for _ in range(400):
            o = list(blocks)
            rng.shuffle(o)
            orders.append(o)
        for cand in papers:   # the order given when it fits; tallest or largest first when that saves a page size
            for order in orders:
                spots = self._pack(order, cand, top)
                if spots:
                    blocks, paper = order, cand
                    break
            if spots:
                break
        if not spots:
            spots = self._pack(blocks, paper, top, force=True)
            problems.append(f"The sheet does not fit on {paper[0]}; split it over several sheets.")
        if paper[0] != before.get("paper", "A4") and abs(paper[1] - (before.get("page") or [297, 210])[0]) > 1:
            self.page(paper[0])
        # ---- 5. move each block into place, then its frame, heading and notes
        for blk, (bx, by) in zip(blocks, spots):
            pad = _PAD if blk["framed"] else 0
            cx, cy = bx + pad, by + pad + (_HEAD if blk["title"] else 0)
            dx, dy = _snap(cx - blk["ext"][0], 2.54), _snap(cy - blk["ext"][1], 2.54)
            if dx < cx - blk["ext"][0]:
                dx += 2.54
            if dy < cy - blk["ext"][1]:
                dy += 2.54
            self._edit({"op": "move_region", "x0": blk["band"][0], "y0": blk["band"][1], "x1": blk["band"][2], "y1": blk["band"][3], "dx": dx, "dy": dy})
            self.flush()
            if not blk["framed"]:
                continue
            x0, y0 = blk["ext"][0] + dx - pad, blk["ext"][1] + dy - pad - (_HEAD if blk["title"] else 0)
            self._edit({"op": "add_rectangle", "x0": _r(x0), "y0": _r(y0), "x1": _r(x0 + blk["w"]), "y1": _r(y0 + blk["h"]), "style": "dash"})
            if blk["title"]:
                self.text(blk["title"], (x0 + _PAD / 2 + 0.6, y0 + _HEAD - 1.4), size=_TITLE, bold=True)
            ny = blk["ext"][3] + dy + pad + _LINE
            for line, _ in blk["lines"]:
                self.text(line, (x0 + pad, ny), italic=True)
                ny += _LINE
            self.flush()
        # ---- 6. what was asked for against what is there
        wrong = self._miswired(nets)
        lay = self.layout(limit=8)
        out = {"placed": len(placed), "nets": len(nets), "sections": len([b for b in blocks if b["framed"]]), "page": paper[0],
               "problems": problems + wrong, "unconnected": self.unconnected()[:40], "overlaps": lay.get("count", 0)}
        if drawer.swapped:
            out["pins_swapped"] = drawer.swapped      # symbols redrawn with supply straps on top and ground straps at the bottom of their side
        if lay.get("count"):
            out["overlap_list"] = [f"{o['what']}: {o['a']} / {o['b']} at ({o['x']}, {o['y']})" for o in lay.get("overlaps", [])]
        self.project.note(f"{self.path}: built {len(placed)} parts and {len(nets)} nets in {out['sections']} sections on {paper[0]}"
                          + (f", {len(out['problems'])} problems" if out["problems"] else "") + (f", {out['overlaps']} overlaps" if out["overlaps"] else ""))
        return out

    def _miswired(self, nets: dict) -> list:
        """Nets whose pins are not all joined to each other and to nothing else.  A net wired inside its block has no
        label, so this compares who is connected to whom, not names."""
        got = self.nets()
        where = {pin: name for name, pins in got.items() for pin in pins}
        mine = {f"{q['ref']}.{q['number']}": name for name, pins in nets.items() for spec in pins for q in self._try_pins(spec)}
        out = []
        for name, pins in nets.items():
            want = {f"{q['ref']}.{q['number']}" for spec in pins for q in self._try_pins(spec)}
            homes = {where.get(pin) for pin in want}
            if len(homes) != 1 or None in homes:
                out.append(f"{name}: not all joined ({', '.join(sorted(want))})")
                continue
            extra = {pin for pin in got[next(iter(homes))] if mine.get(pin, name) != name}
            if extra:
                out.append(f"{name}: also joined to {', '.join(sorted(extra))}")
        return out

    def _repair(self, nets: dict) -> None:
        """Whatever the drawing left open gets its name on every pin, so the sheet is right even where it is not pretty."""
        bad = {m.split(":", 1)[0] for m in self._miswired(nets) if "not all joined" in m}
        for name in bad:
            for spec in nets[name]:
                try:
                    self.net(name, spec)
                except HarnessError:
                    pass
        if bad:
            self.flush()

    def _pack(self, blocks, paper, top=None, force: bool = False):
        """Where each block goes on a page: in the order given, each as high and then as far left as it fits, clear of
        the border and the title block (a skyline, so a short block sits under a short neighbour instead of starting a new row)."""
        _, pw, ph = paper
        left, right, bottom, gap = 15.24, pw - 15.24, ph - 15.24, 5.08
        ty0 = max(top or 15.24, 15.24)
        title = (pw - 125.0, ph - 49.0)
        sky = [(left, right, ty0)]   # (x0, x1, y): the drawing is free below y between x0 and x1
        spots, done = [], []
        for b in blocks:
            w, h = b["w"], b["h"]
            best = None
            xs = sorted({seg[0] for seg in sky})
            for x in xs:
                if x + w > right + 1e-6:
                    continue
                y = max(seg[2] for seg in sky if seg[0] < x + w - 1e-6 and seg[1] > x + 1e-6)
                while True:      # the skyline only keeps the gap to the right of a block: stay clear of every block already placed
                    hit = [r for r in done if x < r[0] + r[2] + gap - 1e-6 and x + w + gap > r[0] + 1e-6 and y < r[1] + r[3] + gap - 1e-6 and y + h + gap > r[1] + 1e-6]
                    if not hit:
                        break
                    y = max(r[1] + r[3] + gap for r in hit)
                if y + h > title[1] and x + w > title[0]:
                    continue
                if y + h > bottom + 1e-6:
                    continue
                if best is None or (y, x) < (best[1], best[0]):
                    best = (x, y)
            if best is None:
                if not force:
                    return None
                best = (left, max(seg[2] for seg in sky))
            x, y = best
            spots.append((x, y))
            done.append((x, y, w, h))
            nx0, nx1, ny = x, min(right, x + w + gap), y + h + gap
            new = []
            for a0, a1, ay in sky:
                if a1 <= nx0 or a0 >= nx1:
                    new.append((a0, a1, ay))
                    continue
                if a0 < nx0:
                    new.append((a0, nx0, ay))
                if a1 > nx1:
                    new.append((nx1, a1, ay))
            new.append((nx0, nx1, ny))
            sky = sorted(new)
        return spots

    def _try_pins(self, spec):
        try:
            return self._pins(spec)
        except HarnessError:
            return []


def _power_symbol(name: str, ground: bool) -> str:
    """A power symbol for a net name KiCad's power library does not have, drawn like the library's own."""
    q = lambda t: '"' + str(t).replace("\\", "\\\\").replace('"', '\\"') + '"'
    hide = '(effects (font (size 1.27 1.27)) (hide yes))'
    line = lambda pts: "\t\t\t(polyline (pts " + " ".join(f"(xy {x} {y})" for x, y in pts) + ") (stroke (width 0) (type default)) (fill (type none)))"
    if ground:
        art, vy, ry, ang = [line([(0, 0), (0, -1.27), (1.27, -1.27), (0, -2.54), (-1.27, -1.27), (0, -1.27)])], -3.81, -6.35, 270
    else:
        art, vy, ry, ang = [line([(-0.762, 1.27), (0, 2.54)]), line([(0, 2.54), (0.762, 1.27)]), line([(0, 0), (0, 2.54)])], 3.556, -3.81, 90
    rows = [f"\t(symbol {q(name)}", "\t\t(power)", "\t\t(pin_numbers (hide yes))", "\t\t(pin_names (offset 0) (hide yes))", "\t\t(exclude_from_sim no)", "\t\t(in_bom yes)", "\t\t(on_board yes)",
            f'\t\t(property "Reference" "#PWR" (at 0 {ry} 0) {hide})',
            f'\t\t(property "Value" {q(name)} (at 0 {vy} 0) (effects (font (size 1.27 1.27))))',
            f'\t\t(property "Footprint" "" (at 0 0 0) {hide})', f'\t\t(property "Datasheet" "" (at 0 0 0) {hide})',
            f'\t\t(property "Description" {q("Power symbol creates a global label with name " + name)} (at 0 0 0) {hide})',
            f'\t\t(property "ki_keywords" "global power" (at 0 0 0) {hide})',
            f"\t\t(symbol {q(name + '_0_1')}"] + art + ["\t\t)", f"\t\t(symbol {q(name + '_1_1')}",
            f'\t\t\t(pin power_in line (at 0 0 {ang}) (length 0) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))',
            "\t\t)", "\t\t(embedded_fonts no)", "\t)"]
    return "\n".join(rows) + "\n"


def _rot(dx: float, dy: float, rotation: int):
    r = rotation % 360
    return {0: (dx, dy), 90: (dy, -dx), 180: (-dx, -dy), 270: (-dy, dx)}[r]


def _ref_key(r: str):
    m = re.match(r"^(\D*)(\d*)(.*)$", r)
    return (m.group(1), int(m.group(2) or 0), m.group(3))


class Board(_Doc):
    """The board."""

    def __init__(self, project, path):
        super().__init__(project, path)
        self._groups: dict = {}
        self._connectivity = []

    # ---- reading
    def parts(self) -> list:
        return [{k: p[k] for k in ("ref", "value", "footprint", "x", "y", "rotation", "side")} for p in self.geometry()["parts"]]

    def refs(self) -> list:
        return sorted((p["ref"] for p in self.geometry()["parts"]), key=_ref_key)

    def pads(self, ref: str) -> list:
        for p in self.geometry()["parts"]:
            if p["ref"].lower() == ref.lower():
                return [{"ref": p["ref"], "number": q[0], "x": q[1], "y": q[2], "net": q[3]} for q in p["pads"]]
        raise HarnessError(f"There is no footprint {ref} on the board.")

    def courtyards(self, refs=None) -> dict:
        """ref -> [x0, y0, x1, y1, side]: the box each part's courtyard takes up as placed (the pad box when the footprint
        draws no courtyard). Read it after `sync()` to plan a floorplan from real sizes instead of guessing."""
        want = {r.lower() for r in ([refs] if isinstance(refs, str) else refs)} if refs else None
        out = {}
        for p in self.geometry()["parts"]:
            if want is not None and p["ref"].lower() not in want:
                continue
            box = p.get("courtyard")
            if not box:
                xs = [q[1] for q in p["pads"]] or [p["x"]]; ys = [q[2] for q in p["pads"]] or [p["y"]]
                box = [min(xs) - 0.5, min(ys) - 0.5, max(xs) + 0.5, max(ys) + 0.5]
            out[p["ref"]] = [round(v, 2) for v in box] + [p["side"]]
        return out

    def clashes(self, gap: float = 0.0) -> list:
        """Pairs of parts on the same side whose courtyards overlap or sit closer than `gap` mm:
        [[a, b, overlap_x_mm, overlap_y_mm], ...]. Moving one of the two by the smaller figure (plus the gap) clears it.
        An empty list is a floorplan DRC will accept; check it before routing, which is the slow step."""
        cy = list(self.courtyards().items()); out = []
        for i, (a, A) in enumerate(cy):
            for b, B in cy[i + 1:]:
                if A[4] != B[4]:
                    continue
                ox = min(A[2], B[2]) - max(A[0], B[0]) + gap; oy = min(A[3], B[3]) - max(A[1], B[1]) + gap
                if ox > 1e-6 and oy > 1e-6:
                    out.append([a, b, round(ox, 2), round(oy, 2)])
        return out

    def pad(self, spec: str) -> dict:
        ref, _, num = spec.partition(".")
        for q in self.pads(ref):
            if q["number"] == num:
                return q
        raise HarnessError(f"{ref} has no pad {num}.")

    def nets(self, filter: str | None = None) -> dict:
        """name -> {"pads": [...], "unrouted": n, "length_mm": x}"""
        r = self._call("list_nets", **({"filter": filter} if filter else {}))
        return {n["name"]: {"pads": n["pads"], "unrouted": n["unrouted_connections"], "length_mm": n["routed_length_mm"]} for n in r.get("nets", [])}

    def unrouted(self) -> dict:
        """Nets that still have missing connections: name -> how many."""
        return {k: v["unrouted"] for k, v in self.nets().items() if v["unrouted"]}

    def info(self) -> dict:
        """Size, layers, rules and layout figures in a few lines."""
        self.flush()
        r = self.project.transport.call("get_board_info", {})
        lay = r.get("layout") or {}
        rules = r.get("design_rules") or {}
        return {"size_mm": r.get("size_mm"), "copper_layers": r.get("copper_layers"), "footprints": (r.get("statistics") or {}).get("footprints", {}).get("total"),
                "nets": r.get("nets"), "unrouted_connections": r.get("unrouted_connections"), "ratsnest_mm": lay.get("ratsnest_mm"), "vias": lay.get("vias"),
                "track_length_mm": lay.get("track_length_mm"), "clearance": rules.get("clearance"), "min_track_width": rules.get("min_track_width")}

    def models(self) -> dict:
        """Which parts show as their real 3D model: {"parts", "from_kicad_library", "from_vendor", "without_model": [{"ref", "footprint", "reason"}]}.
        A footprint from KiCad's library or from a vendor brings its model with it; the 3D view loads it by itself.
        Parts listed under without_model are drawn as a plain stand-in shape."""
        self.flush()
        return self.project.transport.call("get_board_info", {}).get("models_3d") or {}

    # ---- setting up
    def sync(self, placements: dict | None = None) -> dict:
        """Update the board from the schematic: missing footprints are added, pad nets and values brought into line."""
        e: dict = {"op": "update_from_schematic"}
        if placements:
            e["placements"] = {r: ({"x": v[0], "y": v[1], **({"rotation": v[2]} if len(v) > 2 else {})} if not isinstance(v, dict) else v) for r, v in placements.items()}
        if self.project.footprints:
            e["footprints"] = dict(self.project.footprints)
        for d in self.project._open.values():
            if d is not self:
                d.flush()
        self.flush()
        self._edit(e)
        try:
            res = self.flush() or {}
        except HarnessError as err:
            if "already matches the schematic" not in str(err):
                raise
            extra = re.search(r"not in the schematic: (.*)$", str(err))      # nothing to do is a result, not a failure
            return {"added": 0, "updated": 0, "nets": None, "problems": [], "not_in_schematic": [x.strip() for x in extra.group(1).split(",")] if extra else []}
        d = next((x["update_from_schematic"] for x in res.get("details") or [] if "update_from_schematic" in x), {})
        out = {"added": len(d.get("added", [])), "updated": len(d.get("updated", [])), "nets": d.get("nets"), "problems": d.get("problems") or [], "not_in_schematic": d.get("not_in_schematic") or []}
        self.project.note(f"board: synced from the schematic, {out['added']} added, {out['updated']} updated" + (f", problems: {'; '.join(out['problems'][:5])}" if out["problems"] else ""))
        return out

    def outline(self, x0: float, y0: float, x1: float, y1: float) -> None:
        """Draw a rectangular board outline on Edge.Cuts."""
        self.add_item(f'(gr_rect (start {_r(x0)} {_r(y0)}) (end {_r(x1)} {_r(y1)}) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "{_uuid.uuid4()}"))')

    def rules(self, **rules) -> None:
        """Set design rules in mm: clearance, track_width, via_diameter, via_drill, min_track_width, min_clearance, edge_clearance, net_class."""
        self._edit(dict({"op": "set_rules"}, **rules))
        self.flush()

    def zone(self, net: str, layer: str = "B.Cu", box=None, clearance: float = 0.3, connect: str = "thermal") -> None:
        """A copper pour on a net over a rectangle (the board outline by default).

        connect: how pads of the net join it: "thermal" (reliefs, KiCad's default) or "solid"."""
        b = box or self.geometry().get("outline")
        if not b:
            raise HarnessError("The board has no outline yet; draw one or give the zone a box.")
        pts = " ".join(f"(xy {_r(x)} {_r(y)})" for x, y in ((b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])))
        net = self._net(net)
        self.add_item(f'(zone (net "{net}") (layer "{layer}") (uuid "{_uuid.uuid4()}") (hatch edge 0.5) (connect_pads{' yes' if connect == 'solid' else ''} (clearance {clearance})) (min_thickness 0.25) '
                      f'(fill (thermal_gap 0.3) (thermal_bridge_width 0.4)) (polygon (pts {pts})))')

    def keepout(self, box, layers=None, tracks: bool = True, vias: bool = True, copper: bool = True, footprints: bool = False, name: str = "") -> None:
        """A rule area (KiCad keepout) over a rectangle [x0, y0, x1, y1]: nothing of the kinds named may enter it.

        Use it under an antenna (no copper on any layer), for the gap between an analog and a digital section, or to
        hold tracks off a switching converter's inductor.  layers: copper layers it applies to (default all of
        them).  tracks / vias / copper (pours) / footprints: True keeps that out.  The autorouter, the zone filler
        and the design rule check all honour it."""
        ls = list(layers) if layers else list(self.info().get("copper_layers") or ["F.Cu", "B.Cu"])
        x0, y0, x1, y1 = (min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3]))
        pts = " ".join(f"(xy {_r(x)} {_r(y)})" for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)))
        ok = lambda keep: "not_allowed" if keep else "allowed"
        lay = f'(layer "{ls[0]}")' if len(ls) == 1 else "(layers " + " ".join(f'"{l}"' for l in ls) + ")"
        self.add_item(f'(zone (net 0) (net_name "") {lay} (uuid "{_uuid.uuid4()}")' + (f' (name "{name}")' if name else "") + ' (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25) '
                      f'(keepout (tracks {ok(tracks)}) (vias {ok(vias)}) (pads allowed) (copperpour {ok(copper)}) (footprints {ok(footprints)})) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts {pts})))')

    def fill(self) -> dict:
        """Fill every copper zone (KiCad's Fill All Zones) and report the connections still open.

        A pour connects nothing until it is filled, and the design rule check reads the stored fills."""
        self.flush()
        self._edit({"op": "fill_zones"})
        try:
            res = self.flush() or {}
        except HarnessError as err:
            if "already filled" in str(err) or "no copper zone" in str(err):
                return {"zones": 0, "refilled": 0}
            raise
        return next((x["fill_zones"] for x in res.get("details") or [] if "fill_zones" in x), {})

    def pad_connection(self, spec: str, connect: str = "solid") -> None:
        """How a pad joins a zone of its net: "solid", "thermal", "none" or "inherit" (the zone's own setting).  spec is "J2.3"."""
        ref, _, num = spec.partition(".")
        self._edit({"op": "pad_connection", "ref": ref, "pad": num, "connect": connect}, "item:" + ref)

    def fix_thermals(self) -> list:
        """Pads whose thermal relief reaches the pour with too few spokes (DRC: starved_thermal) are joined to it
        solidly, as a person does in Pad Properties, and the zones are filled again.  Returns the pads changed."""
        done: list = []
        for _ in range(3):
            self.fill()
            rows = [v for v in self._call("run_checks").get("violations", []) if v["code"] == "starved_thermal"]
            todo: dict = {}
            for v in rows:
                best = None
                for ref in v.get("refs") or []:
                    try:
                        pads = self.pads(ref)
                    except HarnessError:
                        continue
                    for q in pads:
                        d = (q["x"] - v["x"]) ** 2 + (q["y"] - v["y"]) ** 2
                        if best is None or d < best[0]:
                            best = (d, q["ref"], q["number"])
                if best and f"{best[1]}.{best[2]}" not in done:
                    todo.setdefault(best[1], []).append(best[2])
            if not todo:
                break
            for ref, nums in todo.items():
                self._edit({"op": "pad_connection", "ref": ref, "pads": sorted(set(nums)), "connect": "solid"})
                done += [f"{ref}.{n}" for n in sorted(set(nums))]
            self.flush()
        if done:
            self.fill()
        return done

    def check(self, limit: int = 6, kind: str | None = None, warnings: bool = False, refill: bool = True) -> dict:
        """DRC: counts by kind and the first few violations, errors first.  Zones are refilled first, as KiCad's DRC dialog does.
        `kind` lists only that kind ("unconnected_items", "clearance"); `warnings=True` lists warnings after the errors."""
        if refill:
            self.fill()
        return super().check(limit, kind, warnings)

    # ---- placing
    def place(self, ref: str, at, rotation: float | None = None, side: str | None = None) -> None:
        """Put a footprint at a point, optionally turned and on a side ("front" or "back")."""
        e = {"op": "move", "ref": ref, "x": _r(at[0]), "y": _r(at[1])}
        if rotation is not None:
            e["rotation"] = rotation
        if side:
            e["side"] = side
        self._edit(e, "item:" + ref)

    def move(self, ref: str, to=None, by=None, rotation: float | None = None, side: str | None = None) -> None:
        if to is None:
            p = self._part(ref)
            to = (p["x"] + (by[0] if by else 0), p["y"] + (by[1] if by else 0))
        self.place(ref, to, rotation, side)

    def rotate(self, ref: str, rotation: float) -> None:
        p = self._part(ref)
        self.place(ref, (p["x"], p["y"]), rotation)

    def flip(self, ref: str) -> None:
        p = self._part(ref)
        self.place(ref, (p["x"], p["y"]), side="front" if p["side"] == "back" else "back")

    def _part(self, ref):
        p = next((q for q in self.geometry()["parts"] if q["ref"].lower() == ref.lower()), None)
        if not p:
            raise HarnessError(f"There is no footprint {ref} on the board.")
        return p

    def group(self, name: str, refs: list, anchor: str | None = None) -> None:
        """Declare a functional block: autoplace keeps its parts together around the anchor (the first part by default)."""
        self._groups[name] = {"refs": list(refs), "anchor": anchor or refs[0]}

    def autoplace(self, groups: dict | None = None, near: dict | None = None, edges: dict | None = None, fixed: dict | None = None,
                  outline=None, spacing: float | None = None, only: list | None = None) -> dict:
        """Place footprints with the placement engine: blocks packed around their anchors, blocks arranged inside the outline.

        groups: {block: [refs]} (first ref is the anchor) in addition to those declared with group(); near: {ref: ref}
        for parts that must sit beside another (decoupling, crystal); edges: {ref: "left"|"right"|"top"|"bottom"};
        fixed: {ref: (x, y[, rotation])}.  With nothing given the engine groups the parts itself.
        """
        specs: dict = {}
        allg = dict(self._groups)
        for name, refs in (groups or {}).items():
            allg[name] = {"refs": list(refs), "anchor": refs[0]}
        for name, gdef in allg.items():
            for r in gdef["refs"]:
                specs.setdefault(r, {"ref": r})["group"] = name
            specs[gdef["anchor"]]["anchor"] = True
        for r, n in (near or {}).items():
            specs.setdefault(r, {"ref": r})["near"] = n
        for r, edge in (edges or {}).items():
            specs.setdefault(r, {"ref": r})["edge"] = edge
        for r, v in (fixed or {}).items():
            specs.setdefault(r, {"ref": r})["fixed"] = {"x": v[0], "y": v[1], "rotation": v[2] if len(v) > 2 else 0}
        if only:
            for r in only:
                specs.setdefault(r, {"ref": r})
        e: dict = {"op": "auto_place"}
        if specs:
            e["parts"] = list(specs.values())
        if outline:
            e["outline"] = list(outline)
        if spacing is not None:
            e["spacing"] = spacing
        self._edit(e)
        res = self.flush() or {}
        d = next((x["auto_place"] for x in res.get("details") or [] if "auto_place" in x), {})
        out = {"placed": len(d.get("placements", [])), "score": d.get("score"), "outline": d.get("outline"), "unknown_refs": d.get("unknown_refs") or []}
        self.project.note(f"board: placed {out['placed']} footprints, score {out['score']}")
        return out

    # ---- copper
    def track(self, net: str, points, layer: str = "F.Cu", width: float | None = None) -> None:
        """A track through points; a point may be a pad written "REF.pad"."""
        pts = []
        for p in points:
            if isinstance(p, str):
                q = self.pad(p)
                pts.append([q["x"], q["y"]])
            else:
                pts.append([_r(p[0]), _r(p[1])])
        e = {"op": "add_track", "net": net, "layer": layer, "points": pts}
        if width:
            e["width"] = width
        self._edit(e)

    def via(self, net: str, at, size: float | None = None, drill: float | None = None) -> None:
        e = {"op": "add_via", "net": net, "x": _r(at[0]), "y": _r(at[1])}
        if size:
            e["size"] = size
        if drill:
            e["drill"] = drill
        self._edit(e)

    def clear(self, keep: tuple = (), outline: bool = True) -> int:
        """Take everything off the board for a rebuild from nothing: footprints, tracks, vias, zones, drawings.  The board
        outline stays unless outline=False.  Returns how many items were removed."""
        self._keep_outline = outline
        return super().clear(keep)

    def _kept(self, it: dict) -> bool:
        return getattr(self, "_keep_outline", True) and str(it.get("kind", "")).startswith("gr_") and "Edge.Cuts" in it.get("sexpr", "")

    def unroute(self, *nets: str, keep: tuple = ("GND",)) -> int:
        """Take the tracks and vias of these nets off the board (of every net but `keep` when none is named), so that
        a crowded area can be laid again together.  Returns how many were removed."""
        names = [self._net(n) for n in nets] if nets else [n for n in self.nets() if n not in keep]
        count = 0
        for net in names:
            for _ in range(40):   # get_items answers in pages: take a page off the board, ask again
                got = self._call("get_items", net=net, kinds=["segment", "arc", "via"])
                for it in got.get("items", []):
                    self._edit({"op": "remove", "id": it["id"]})
                    count += 1
                self.flush()
                if not got.get("truncated") or not got.get("items"):
                    break
        if count:
            self.project.note(f"board: took up {count} tracks and vias of {len(names)} nets")
        return count

    def _net(self, name: str) -> str:
        """A net by the name the schematic gave it: the board calls a sheet's local net "/NAME"."""
        names = self.__dict__.get("_names")
        if names is None or name not in names and "/" + name.lstrip("/") not in names:
            names = self._names = set(self.nets())
        bare = name.lstrip("/")
        hit = name if name in names else "/" + bare if "/" + bare in names else bare if bare in names else None
        if hit is None and bare in self.project.net_pins:     # a net wired inside its block: KiCad named it after a pin
            try:
                hit = self.pad(self.project.net_pins[bare])["net"] or None
            except HarnessError:
                hit = None
        return hit or name

    def route(self, nets: list | None = None, order: list | None = None, widths: dict | None = None, layers: list | None = None,
              net_options: dict | None = None, keepouts: list | None = None, allow_vias: bool = True, time_s: float | None = None,
              fill: bool = True, max_vias: int | None = None, kinds: dict | None = None, separate=None, fence=None) -> dict:
        """Autoroute the missing connections (every unrouted net by default) and report what was done.

        order: the few nets to lay first (USB pair, crystal); widths: {net: mm} for supply nets; net_options and
        keepouts are passed to the engine as they are.  Route a whole board in one call.
        max_vias: the most vias one pad-to-pad connection may use (2 keeps every track to one trip to the other side).

        Signal domains.  The engine tells analog nets (ADC, VREF, crystal, sense, feedback), RF nets (ANT, RF),
        switching nodes (SW, LX), fast nets (clocks, differential pairs) and plain digital ones apart by name, and
        keeps analog and RF tracks away from the rest (except at pads and within 1.2 mm of one).  kinds: {net: "analog" | "rf" | "switching" |
        "fast" | "digital" | "supply"} says what a net is when its name does not.  separate: False turns this off,
        {"quiet": mm, "noisy": mm} sets the gap to digital tracks and to switching / fast ones.
        fence: RF nets get ground vias down both sides of their tracks, and RF, clock and pair nets a ground via beside
        each layer change, wherever ground is poured on two layers.  False turns it off; {"spacing": mm, "nets":
        [...], "return_vias": False} sets the pitch, fences more nets, or drops the return vias.
        The result's `domains` and `ground_vias` say what was kept apart, where the gap had to give, and how many
        vias went in.  Areas nothing may cross (under an antenna, an isolation gap) are `board.keepout(...)`.

        On a board with copper zones the zones are then filled, what the real fill leaves open is routed again
        (twice at most) and the zones are filled once more, so the result counts a pour the way KiCad does.
        `left` is the connections still open at the end, by net.  Net names are the schematic's ("SW" finds "/SW").
        """
        self.flush()
        fix = self._net
        e: dict = {"op": "autoroute"}
        if nets:
            e["nets"] = [fix(n) for n in nets]
        if order:
            e["order"] = [fix(n) for n in order]
        opts = {fix(k): dict(v) for k, v in (net_options or {}).items()}
        for n, w in (widths or {}).items():
            opts.setdefault(fix(n), {})["width"] = w
        for n, kd in (kinds or {}).items():
            opts.setdefault(fix(n), {})["kind"] = kd
        if self.project.net_pins:      # nets wired inside their block have KiCad's automatic names: tell the router what they were called
            known = set(self.nets())
            for name, pin in self.project.net_pins.items():
                if name in known or "/" + name in known:
                    continue
                try:
                    auto = self.pad(pin)["net"]
                except HarnessError:
                    continue
                if auto and "kind" not in opts.get(auto, {}):
                    opts.setdefault(auto, {})["named"] = name
        if opts:
            e["net_options"] = opts
        if layers:
            e["layers"] = list(layers)
        if keepouts:
            e["keepouts"] = keepouts
        if not allow_vias:
            e["allow_vias"] = False
        if time_s:
            e["time_s"] = time_s
        if max_vias is not None:
            e["max_vias"] = max_vias
        if separate is not None:
            e["separate"] = separate
        if fence is not None:
            e["fence"] = dict(fence, nets=[fix(n) for n in fence["nets"]]) if isinstance(fence, dict) and fence.get("nets") else fence
        out = self._autoroute(e)
        if fill:
            f = self.fill()
            if f.get("zones"):
                again = {k: v for k, v in e.items() if k != "order"}
                again["time_s"] = min(60, time_s or 60)
                for _ in range(2):
                    if not f.get("unconnected"):
                        break
                    # what the real fill left open is laid with tracks: the engine must not count on the pour again
                    again["zones"] = False
                    again["nets"] = sorted(f.get("unconnected_by_net") or {}) or again.get("nets")
                    if not again["nets"]:
                        again.pop("nets")
                    more = self._autoroute(again)
                    if not more["routed"]:
                        break
                    for k in ("routed", "connections", "segments", "vias"):
                        out[k] = (out[k] or 0) + (more[k] or 0)
                    out["length_mm"] = round((out["length_mm"] or 0) + (more["length_mm"] or 0), 3)
                    out["unrouted"] = more["unrouted"]
                    f = self.fill()
                solid = self.fix_thermals()
                if solid:
                    out["pads_made_solid"] = solid   # a relief the tracks left with too few spokes
                    f = dict(self.fill(), zones=f.get("zones"))
                out["zones_filled"] = f.get("zones")
                out["left"] = f.get("unconnected_by_net") or {}
        if "left" not in out:
            out["left"] = self.unrouted()
        self.project.note(f"board: routed {out['routed']} of {out['connections']} connections, {out['vias']} vias, {out['length_mm']} mm" + (f", {len(out['unrouted'])} left" if out["unrouted"] else ""))
        return out

    def _autoroute(self, e: dict) -> dict:
        """One autoroute edit.  Nothing to route, or nothing that could be routed, is a result and not an error."""
        self.flush()
        self._edit(dict(e))
        try:
            res = self.flush() or {}
        except HarnessError as err:
            if "nothing to route" in str(err):
                return {"routed": 0, "connections": 0, "segments": 0, "vias": 0, "length_mm": 0, "unrouted": []}
            if "could not make any" in str(err):
                return {"routed": 0, "connections": None, "segments": 0, "vias": 0, "length_mm": 0, "unrouted": [str(err).split("(autoroute): ")[-1][:400]]}
            raise
        d = next((x["autoroute"] for x in res.get("details") or [] if "autoroute" in x), {})
        un = [f"{u.get('net')}: {u.get('from')} to {u.get('to')} ({u.get('reason') or 'no path'})" for u in d.get("unrouted", [])]
        out = {"routed": d.get("routed"), "connections": d.get("connections"), "segments": d.get("segments"), "vias": d.get("vias"), "length_mm": d.get("length_mm"), "unrouted": un[:25]}
        if len(un) > 25:
            out["more_unrouted"] = len(un) - 25
        for k in ("domains", "ground_vias"):
            if d.get(k):
                out[k] = d[k]
        return out

    def layers(self, count: int, planes: list | None = None) -> None:
        """Set the number of copper layers (2, 4, 6, ...).  Inner layers are In1.Cu, In2.Cu, ...; `planes` names the ones
        that are power planes, for example layers(4, planes=["In1.Cu", "In2.Cu"]) and then zone("GND", "In1.Cu")."""
        e: dict = {"op": "set_layers", "count": count}
        if planes:
            e["planes"] = list(planes)
        self.flush()
        self._edit(e)
        self.flush()
        self._geom = None

    def connect(self, *pads, width: float | None = None, time_s: float | None = None) -> dict:
        """Route the net that joins these pads ("U1.3", "R1.1")."""
        nets = []
        for spec in pads:
            n = self.pad(spec)["net"]
            if not n:
                raise HarnessError(f"{spec} is on no net; connect it in the schematic and sync the board first.")
            if n not in nets:
                nets.append(n)
        if len(nets) > 1:
            raise HarnessError(f"These pads are on different nets ({', '.join(nets)}); a track cannot join them. Change the schematic and sync.")
        return self.route(nets=nets, widths={nets[0]: width} if width else None, time_s=time_s)
