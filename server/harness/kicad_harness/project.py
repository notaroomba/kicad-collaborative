"""Projects, schematic sheets and boards as plain Python objects.

Nothing here writes KiCad file text.  Each method turns into one or a few edits for the design
engine (the editor's own code), which keeps the files valid and, on an online project, sends the
edits to everyone in the document.  Results are short summaries: references, counts and what
went wrong, never file contents.
"""
from __future__ import annotations

import math
import re
import uuid as _uuid

from .transport import HarnessError, Transport

GRID = 1.27
STUB = 2.54
_DIR = {"left": (-1, 0), "right": (1, 0), "top": (0, -1), "bottom": (0, 1)}
_LABEL_ROT = {"left": 180, "right": 0, "top": 90, "bottom": 270}
_GND_ROT = {"bottom": 0, "right": 90, "top": 180, "left": 270}
_SUPPLY_ROT = {"top": 0, "left": 90, "bottom": 180, "right": 270}
_GROUND = re.compile(r"^(A|D|P)?(GND|VSS|VEE)|^GND|^-\d|^Earth", re.I)
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

    def check(self, limit: int = 6) -> dict:
        """Run the rules check (ERC on a sheet, DRC on the board): counts by kind and the first few violations."""
        r = self._call("run_checks")
        kinds: dict = {}
        for v in r.get("violations", []):
            if v["severity"] == "error":
                kinds[v["code"]] = kinds.get(v["code"], 0) + 1
        first = [f"{v['severity']} {v['code']}: {v['message']}" + (f" [{', '.join(v['refs'])}]" if v.get("refs") else "") + f" at ({v['x']}, {v['y']})"
                 for v in r.get("violations", []) if v["severity"] == "error"][:limit]
        return {"check": r.get("check"), "errors": r.get("errors", 0), "warnings": r.get("warnings", 0), "by_kind": kinds, "first": first}

    def remove(self, *refs: str) -> None:
        for ref in refs:
            self._edit({"op": "remove", "ref": ref} if not re.fullmatch(r"[0-9a-f-]{36}", ref) else {"op": "remove", "id": ref}, "item:" + ref)

    def set(self, ref: str, **fields) -> None:
        """Set fields of a part: value=, footprint=, datasheet=, or any field name."""
        for name, value in fields.items():
            self._edit({"op": "set_field", "ref": ref, "field": {"value": "Value", "footprint": "Footprint", "datasheet": "Datasheet", "reference": "Reference"}.get(name, name), "value": str(value)}, "item:" + ref)
            self.flush()   # one item may take several fields: each is its own batch

    def text(self, text: str, at) -> None:
        self._edit({"op": "add_text", "text": text, "x": at[0], "y": at[1]})

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
            self._edit({"op": "add_symbol", "lib_id": lib_id, "x": at[0], "y": at[1], "rotation": rot})

    def _is_power(self, name: str) -> bool:
        if not _POWER.match(name):
            return False
        try:
            return bool(self.lib("power:" + name).get("power_symbol", True))
        except HarnessError:
            return False

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

    # ---- a whole sheet from a netlist
    def build(self, parts: dict, nets: dict, groups: dict | None = None, no_connect: list | None = None) -> dict:
        """Draw a schematic from a netlist in one call.

        parts: {ref: {"lib": "Device:R", "value": "10k", "footprint": "...", "fields": {...}}} (lib may be a
        generated part or a vendor part).  nets: {name: ["U1.3", "R1.1", ...]}.  groups: {block: [refs]} keeps the
        parts of one functional block together.  Every pin gets a power symbol or a net label on a short stub, so
        the result is correct by construction; ICs sit at the left of their block with their passives beside them.
        Returns counts and anything that did not connect.
        """
        groups = groups or {"main": list(parts)}
        seen = {r for rs in groups.values() for r in rs}
        rest = [r for r in parts if r not in seen]
        if rest:
            groups = {**groups, "other": rest}
        self.flush()
        g = self.geometry()
        page = g.get("page") or [297, 210]
        top = max([p["box"][3] for p in g["parts"] if p.get("box")] + [12.7]) + 12.7
        x0 = 25.4
        cx, cy, row_h = x0, top, 0.0
        placed = []
        for gname, refs in groups.items():
            big, small = [], []
            for r in refs:
                spec = parts[r]
                lib = spec.get("lib") if isinstance(spec, dict) else spec
                b = self._box(lib if not isinstance(lib, dict) else None)
                n = len(self.lib(lib)["units"][0]["pins"]) if not isinstance(lib, dict) else 8
                (big if n > 3 else small).append((r, spec if isinstance(spec, dict) else {"lib": spec}, lib, b))
            # block size: ICs in a column, small parts in rows of up to six beside them
            cell_w, cell_h = 20.32, 30.48
            bw = max([b[2] - b[0] + 50.8 for _, _, _, b in big] + [0])
            bh = sum(b[3] - b[1] + 25.4 for _, _, _, b in big)
            cols = min(6, max(1, len(small)))
            sw = cols * cell_w if small else 0
            sh = math.ceil(len(small) / cols) * cell_h if small else 0
            w, h = bw + sw + 10.16, max(bh, sh) + 10.16
            if cx > x0 and cx + w > page[0] - 15:
                cx, cy, row_h = x0, cy + row_h + 7.62, 0.0
            y = cy + 12.7
            for r, spec, lib, b in big:
                at = (_snap(cx + 25.4 - b[0], 2.54), _snap(y - b[1], 2.54))
                self.place(lib, at=at, ref=r, value=spec.get("value"), footprint=spec.get("footprint"), fields=spec.get("fields"), rotation=spec.get("rotation", 0))
                y += b[3] - b[1] + 25.4
            for i, (r, spec, lib, b) in enumerate(small):
                at = (_snap(cx + bw + (i % cols) * cell_w + cell_w / 2, 2.54), _snap(cy + (i // cols) * cell_h + cell_h / 2, 2.54))
                self.place(lib, at=at, ref=r, value=spec.get("value"), footprint=spec.get("footprint"), fields=spec.get("fields"), rotation=spec.get("rotation", 0))
            if gname not in ("main", "other"):
                self.text(gname, (cx + 2.54, cy + 2.54))
            placed += refs
            cx += w
            row_h = max(row_h, h)
        self.flush()
        problems = []
        for name, pins in nets.items():
            for spec in pins:
                try:
                    self.net(name, spec)
                except HarnessError as e:
                    problems.append(str(e))
        for spec in no_connect or []:
            try:
                self.no_connect(spec)
            except HarnessError as e:
                problems.append(str(e))
        self.flush()
        got = self.nets()
        wrong = []
        for name, pins in nets.items():
            have = set()
            for n, ps in got.items():
                if n == name or n.lstrip("/") == name:
                    have |= set(ps)
            want = {f"{q['ref']}.{q['number']}" for spec in pins for q in self._try_pins(spec)}
            if want - have:
                wrong.append(f"{name}: missing {', '.join(sorted(want - have))}")
        out = {"placed": len(placed), "nets": len(nets), "problems": problems + wrong, "unconnected": self.unconnected()[:40]}
        self.project.note(f"{self.path}: built {len(placed)} parts and {len(nets)} nets" + (f", {len(out['problems'])} problems" if out["problems"] else ""))
        return out

    def _try_pins(self, spec):
        try:
            return self._pins(spec)
        except HarnessError:
            return []


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
        self._edit(e)
        res = self.flush() or {}
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
        self.add_item(f'(zone (net "{net}") (layer "{layer}") (uuid "{_uuid.uuid4()}") (hatch edge 0.5) (connect_pads{' yes' if connect == 'solid' else ''} (clearance {clearance})) (min_thickness 0.25) '
                      f'(fill (thermal_gap 0.3) (thermal_bridge_width 0.4)) (polygon (pts {pts})))')

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

    def check(self, limit: int = 6, refill: bool = True) -> dict:
        """DRC: counts by kind and the first few violations.  Zones are refilled first, as KiCad's DRC dialog does."""
        if refill:
            self.fill()
        return super().check(limit)

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

    def route(self, nets: list | None = None, order: list | None = None, widths: dict | None = None, layers: list | None = None,
              net_options: dict | None = None, keepouts: list | None = None, allow_vias: bool = True, time_s: float | None = None,
              fill: bool = True, max_vias: int | None = None) -> dict:
        """Autoroute the missing connections (every unrouted net by default) and report what was done.

        order: the few nets to lay first (USB pair, crystal); widths: {net: mm} for supply nets; net_options and
        keepouts are passed to the engine as they are.  Route a whole board in one call.
        max_vias: the most vias one pad-to-pad connection may use (2 keeps every track to one trip to the other side).

        On a board with copper zones the zones are then filled, what the real fill leaves open is routed again
        (twice at most) and the zones are filled once more, so the result counts a pour the way KiCad does.
        `left` is the connections still open at the end, by net.
        """
        e: dict = {"op": "autoroute"}
        if nets:
            e["nets"] = list(nets)
        if order:
            e["order"] = list(order)
        opts = {k: dict(v) for k, v in (net_options or {}).items()}
        for n, w in (widths or {}).items():
            opts.setdefault(n, {})["width"] = w
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
        out = self._autoroute(e)
        if fill:
            f = self.fill()
            if f.get("zones"):
                again = {k: v for k, v in e.items() if k != "order"}
                again["time_s"] = min(60, time_s or 60)
                for _ in range(2):
                    if not f.get("unconnected"):
                        break
                    more = self._autoroute(again)
                    if not more["routed"]:
                        break
                    for k in ("routed", "connections", "segments", "vias"):
                        out[k] = (out[k] or 0) + (more[k] or 0)
                    out["length_mm"] = round((out["length_mm"] or 0) + (more["length_mm"] or 0), 3)
                    out["unrouted"] = more["unrouted"]
                    f = self.fill()
                out["zones_filled"] = f.get("zones")
                out["left"] = f.get("unconnected_by_net") or {}
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
        return out

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
